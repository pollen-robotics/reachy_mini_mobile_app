/**
 * React binding of the daemon's NFC reader, for the topbar pill and the
 * Settings NFC section (one instance, in the session screen).
 *
 * Polls `nfc.status` (and `nfc.tag` while a reader is connected) once a
 * second while `active` and the phone is in the foreground. Stops once the
 * answer cannot change: no NFC on the daemon, or no reader. A daemon whose
 * version predates NFC is never asked: it reads as unsupported at once.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { rpcErrorReason, type ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { createNfcClient } from './client';
import { daemonPredatesNfc, deriveNfcState, isReaderAbsentForGood } from './nfcState';
import type { NfcState, NfcStatus, NfcTag, NfcTagResult, NfcWriteContent } from './nfcState';

const POLL_INTERVAL_MS = 1_000;

/** Shown instead of the SDK's error ("rpcCall(nfc.status) timed out…"). */
const NO_ANSWER = 'The robot is not answering. Retrying…';

export interface UseNfcReaderOptions {
  getRobot: () => ReachyMiniInstance | null;
  /** Poll the reader: the session is live and no app holds the robot. */
  active: boolean;
  /** Daemon version read at bring-up, `null` when unknown. */
  daemonVersion: string | null;
}

export interface UseNfcReaderResult {
  status: NfcStatus | null;
  tag: NfcTag | null;
  state: NfcState;
  /** Set when the daemon could not be asked (network, timeout). */
  fetchError: string | null;
  /** The daemon has no NFC support: the robot needs an update. */
  unsupported: boolean;
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

export function useNfcReader({
  getRobot,
  active,
  daemonVersion,
}: UseNfcReaderOptions): UseNfcReaderResult {
  const [status, setStatus] = useState<NfcStatus | null>(null);
  const [tag, setTag] = useState<NfcTag | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [probedUnsupported, setProbedUnsupported] = useState(false);
  const predatesNfc = daemonPredatesNfc(daemonVersion);
  const unsupported = predatesNfc || probedUnsupported;
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
    if (!active || !visible || predatesNfc) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      let final = false;
      try {
        const client = clientFor();
        if (!client) {
          // Not connected yet: the card says it is waiting for the robot.
          if (cancelled) return;
          setStatus(null);
          setTag(null);
          setFetchError(null);
          return;
        }
        let nextStatus: NfcStatus;
        try {
          nextStatus = await client.status();
        } catch (err) {
          // A reason: the daemon has no `nfc.*`. None: no answer.
          if (!rpcErrorReason(err)) throw err;
          final = true;
          if (cancelled) return;
          setProbedUnsupported(true);
          setStatus(null);
          setTag(null);
          setFetchError(null);
          return;
        }
        final = isReaderAbsentForGood(nextStatus);
        // A refused tag request reads as no tag; an unanswered one fails the poll.
        const nextTag = nextStatus.connected
          ? await client.tag().catch((err: unknown) => {
              if (rpcErrorReason(err)) return null;
              throw err;
            })
          : null;
        if (cancelled) return;
        setStatus(nextStatus);
        setTag(nextTag);
        setFetchError(null);
        setProbedUnsupported(false);
      } catch (err) {
        if (cancelled) return;
        setStatus(null);
        setTag(null);
        console.warn('[nfc] status poll failed:', err);
        setFetchError(NO_ANSWER);
      } finally {
        if (!cancelled && !final) timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, visible, predatesNfc, clientFor]);

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
        const reason = rpcErrorReason(err);
        error = reason
          ? `Could not switch the reader ${enabled ? 'on' : 'off'} (${reason})`
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
    unsupported,
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
