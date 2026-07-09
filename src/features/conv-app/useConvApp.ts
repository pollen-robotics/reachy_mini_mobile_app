/**
 * React-query state for the on-robot conversation app, over the JSON-RPC
 * data-channel client. Gated on `hasReachedReady` (the data channel is up).
 * App lifecycle is polled (no event for it); the live turn state is driven by
 * `conversation.turn` notifications instead of polling, and turn changes
 * refresh the backend status.
 *
 * Auto-start: the first time the panel sees the robot with NO app running,
 * it starts the conversation app by itself (installing it first when the
 * robot doesn't have it yet). One attempt per mount — a user who then taps
 * Stop is not fought by a restart loop, and another running app (telepresence,
 * cameraman, …) is never hijacked: taking over goes through the explicit
 * start button, which stops the other app first.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';

import { CONV_APP_NAME, createConvAppClient, type ConvAppClient } from './client';

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
  const [installing, setInstalling] = useState(false);

  const appStatus = useQuery({
    queryKey: [...KEY, 'app-status'],
    queryFn: () => clientFor(session).getCurrentAppStatus(),
    enabled,
    refetchInterval: APP_STATUS_POLL_MS,
  });
  const runningAppName =
    appStatus.data?.state === 'running' ? (appStatus.data.info?.name ?? null) : null;
  const running = runningAppName === CONV_APP_NAME;
  const otherAppRunning = runningAppName !== null && !running;

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
    mutationFn: async () => {
      const client = clientFor(session);
      // Taking over from another app is explicit (start-button path):
      // free the robot's app slot before launching the conversation.
      if (otherAppRunning) {
        await client.stopConvApp();
      }
      try {
        await client.startConvApp();
      } catch (err) {
        // Another app raced us for the slot: surface it, don't install.
        if ((err as { reason?: string }).reason === 'already_running') throw err;
        // Most likely the app isn't installed on this robot yet (fresh
        // robot / factory reset). Install-if-missing (no-op when it was
        // some other failure and the app IS installed), then retry once —
        // the second failure carries the real error.
        setInstalling(true);
        try {
          await client.installConvApp();
        } finally {
          setInstalling(false);
        }
        await client.startConvApp();
      }
    },
    onSuccess: invalidate,
  });
  const stop = useMutation({
    mutationFn: () => clientFor(session).stopConvApp(),
    onSuccess: invalidate,
  });

  // Auto-start: one attempt per mount, only when the robot has no app at
  // all (never hijack a running app), once the first status readout is in.
  const autoStartAttemptedRef = useRef(false);
  const startMutate = start.mutate;
  useEffect(() => {
    if (!enabled || autoStartAttemptedRef.current) return;
    if (appStatus.data === undefined) return; // first readout not in yet
    autoStartAttemptedRef.current = true;
    if (runningAppName === null) {
      startMutate();
    }
  }, [enabled, appStatus.data, runningAppName, startMutate]);

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
    otherAppRunning,
    runningAppName,
    installing,
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
