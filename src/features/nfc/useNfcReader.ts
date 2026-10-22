/**
 * React binding of the daemon's NFC reader, for the topbar pill and the
 * Settings NFC section (one instance, in the session screen).
 *
 * Polls `nfc.status` (and `nfc.tag` while a reader is connected) once a
 * second while `active` and the phone is in the foreground, like the
 * desktop app's status button.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { rpcErrorReason, type ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { createNfcClient } from './client';
import { deriveNfcState } from './nfcState';
import type { NfcState, NfcStatus, NfcTag, NfcTagResult, NfcWriteContent } from './nfcState';

const POLL_INTERVAL_MS = 1_000;

export interface UseNfcReaderOptions {
  getRobot: () => ReachyMiniInstance | null;
  /** Poll the reader: the session is up and the NFC section is on screen. */
  active: boolean;
}

export interface UseNfcReaderResult {
  status: NfcStatus | null;
  tag: NfcTag | null;
  state: NfcState;
  /** Set when the daemon could not be asked at all (older daemon, network). */
  fetchError: string | null;
  isErasing: boolean;
  eraseResult: NfcTagResult | null;
  erase: (full: boolean) => Promise<void>;
  isWriting: boolean;
  writeResult: NfcTagResult | null;
  write: (content: NfcWriteContent) => Promise<void>;
  /** False on a daemon too old to switch the reader, or not answering. */
  canToggle: boolean;
  isToggling: boolean;
  toggleError: string | null;
  setEnabled: (enabled: boolean) => Promise<void>;
  /** Forget the last erase and write outcomes. */
  clearResults: () => void;
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
  return visible;
}

export function useNfcReader({ getRobot, active }: UseNfcReaderOptions): UseNfcReaderResult {
  const [status, setStatus] = useState<NfcStatus | null>(null);
  const [tag, setTag] = useState<NfcTag | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isErasing, setIsErasing] = useState(false);
  const [eraseResult, setEraseResult] = useState<NfcTagResult | null>(null);
  const [isWriting, setIsWriting] = useState(false);
  const [writeResult, setWriteResult] = useState<NfcTagResult | null>(null);
  const [isToggling, setIsToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const visible = useDocumentVisible();

  // Latest getter on a ref: the session hook may hand a new one per render,
  // which must not restart the poll.
  const getRobotRef = useRef(getRobot);
  useEffect(() => {
    getRobotRef.current = getRobot;
  }, [getRobot]);
  const clientFor = useCallback(() => {
    const robot = getRobotRef.current();
    return robot ? createNfcClient(robot) : null;
  }, []);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active || !visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      try {
        const client = clientFor();
        if (!client) throw new Error('Waiting for the robot…');
        const nextStatus = await client.status();
        // The daemon answers "no tag" when the reader is not connected, so
        // the request would tell us nothing.
        const nextTag = nextStatus.connected ? await client.tag().catch(() => null) : null;
        if (cancelled) return;
        setStatus(nextStatus);
        setTag(nextTag);
        setFetchError(null);
      } catch (err) {
        if (cancelled) return;
        setStatus(null);
        setTag(null);
        // A daemon without `nfc.*` relays the call to the running app (or
        // finds none), and answers with a reason; a timeout carries none.
        setFetchError(
          rpcErrorReason(err)
            ? 'This robot software has no NFC support yet. Update it to use the reader.'
            : err instanceof Error
              ? err.message
              : String(err)
        );
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, visible, clientFor]);

  const erase = useCallback(
    async (full: boolean): Promise<void> => {
      const client = clientFor();
      setIsErasing(true);
      setEraseResult(null);
      setWriteResult(null);
      const result = client ? await client.erase(full) : { success: false, error: 'LINK_LOST' };
      if (!mountedRef.current) return;
      setEraseResult(result);
      setIsErasing(false);
    },
    [clientFor]
  );

  const write = useCallback(
    async (content: NfcWriteContent): Promise<void> => {
      const client = clientFor();
      setIsWriting(true);
      setEraseResult(null);
      setWriteResult(null);
      const result = client ? await client.write(content) : { success: false, error: 'LINK_LOST' };
      if (!mountedRef.current) return;
      setWriteResult(result);
      setIsWriting(false);
    },
    [clientFor]
  );

  const clearResults = useCallback(() => {
    setEraseResult(null);
    setWriteResult(null);
  }, []);

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      setIsToggling(true);
      setToggleError(null);
      let error: string | null = null;
      let nextStatus: NfcStatus | null = null;
      try {
        const client = clientFor();
        if (!client) throw new Error('no robot');
        nextStatus = await client.setEnabled(enabled);
      } catch (err) {
        error = rpcErrorReason(err)
          ? `Could not switch the reader ${enabled ? 'on' : 'off'}`
          : 'Lost the link to the robot';
      }
      if (!mountedRef.current) return;
      // Show the switch's new position now rather than at the next poll.
      if (nextStatus) {
        setStatus(nextStatus);
        if (!nextStatus.connected) setTag(null);
      }
      setToggleError(error);
      setIsToggling(false);
    },
    [clientFor]
  );

  return {
    status,
    tag,
    state: deriveNfcState(status, tag),
    fetchError,
    isErasing,
    eraseResult,
    erase,
    isWriting,
    writeResult,
    write,
    clearResults,
    canToggle: typeof status?.enabled === 'boolean',
    isToggling,
    toggleError,
    setEnabled,
  };
}
