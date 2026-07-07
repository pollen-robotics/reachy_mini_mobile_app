/**
 * React-query state for the on-robot conversation app, over the JSON-RPC
 * data-channel client. Gated on `hasReachedReady` (the data channel is up).
 * App lifecycle is polled (no event for it); the live turn state is driven by
 * `conversation.turn` notifications instead of polling, and turn changes
 * refresh the backend status.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';

import { createConvAppClient, type ConvAppClient } from './client';

const KEY = ['conv-app'] as const;
const APP_STATUS_POLL_MS = 5000;

function clientFor(session: RobotSessionHandle): ConvAppClient {
  const robot = session.getRobot();
  if (!robot) throw new Error('not connected');
  return createConvAppClient(robot);
}

export function useConvApp(session: RobotSessionHandle, enabled: boolean) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: KEY });
  const [turnState, setTurnState] = useState<string | null>(null);

  const appStatus = useQuery({
    queryKey: [...KEY, 'app-status'],
    queryFn: () => clientFor(session).getCurrentAppStatus(),
    enabled,
    refetchInterval: APP_STATUS_POLL_MS,
  });
  const running = appStatus.data?.state === 'running';

  const status = useQuery({
    queryKey: [...KEY, 'status'],
    queryFn: () => clientFor(session).getStatus(),
    enabled: enabled && running,
  });
  const mic = useQuery({
    queryKey: [...KEY, 'mic'],
    queryFn: () => clientFor(session).getMicMuted(),
    enabled: enabled && running,
  });
  const personalities = useQuery({
    queryKey: [...KEY, 'personalities'],
    queryFn: () => clientFor(session).getPersonalities(),
    enabled: enabled && running,
  });
  const voices = useQuery({
    queryKey: [...KEY, 'voices'],
    queryFn: async () => {
      const c = clientFor(session);
      const [list, current] = await Promise.all([c.getVoices(), c.getCurrentVoice()]);
      return { list, current };
    },
    enabled: enabled && running,
  });

  // Live turn state (listening/thinking/speaking) over conversation.turn,
  // instead of polling. A turn change also refreshes the backend status.
  useEffect(() => {
    if (!enabled || !running) {
      setTurnState(null);
      return;
    }
    const robot = session.getRobot();
    if (!robot) return;
    const client = createConvAppClient(robot);
    const off = client.on('conversation.turn', p => {
      setTurnState((p.state as string | undefined) ?? null);
      qc.invalidateQueries({ queryKey: [...KEY, 'status'] });
    });
    return off;
  }, [enabled, running, session, qc]);

  const start = useMutation({
    mutationFn: () => clientFor(session).startConvApp(),
    onSuccess: invalidate,
  });
  const stop = useMutation({
    mutationFn: () => clientFor(session).stopConvApp(),
    onSuccess: invalidate,
  });
  const setMic = useMutation({
    mutationFn: (muted: boolean) => clientFor(session).setMicMuted(muted),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'mic'] }),
  });
  const applyPersonality = useMutation({
    mutationFn: (name: string) => clientFor(session).applyPersonality(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'personalities'] }),
  });
  const applyVoice = useMutation({
    mutationFn: (voice: string) => clientFor(session).applyVoice(voice),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'voices'] }),
  });

  return {
    running,
    appStatusLoading: appStatus.isLoading,
    status: status.data ?? null,
    micMuted: mic.data ?? null,
    personalities: personalities.data ?? null,
    voices: voices.data ?? null,
    turnState,
    start,
    stop,
    setMic,
    applyPersonality,
    applyVoice,
  };
}
