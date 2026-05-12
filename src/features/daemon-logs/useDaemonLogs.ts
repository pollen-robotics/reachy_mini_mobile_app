/**
 * Hook that consumes the daemon's WebRTC log stream and exposes a
 * ring-buffered list of normalized entries plus a connection
 * status.
 *
 * Lifecycle
 * ─────────
 * Re-subscribes whenever `enabled` flips to true OR when
 * `subscribeLogs` changes identity (e.g. the engine re-boots after
 * a release / reacquire cycle and the underlying SDK instance
 * rotates - the `RobotSessionHandle.subscribeLogs` reference is
 * stable across this so in practice the only re-subscription is
 * the enable/disable transition driven by the host's `isLive`).
 *
 * On disable / unmount we call the SDK-returned `unsubscribe()` so
 * the daemon can tear down its `journalctl` subprocess if no other
 * peer is listening (the shared-stream rule lives in the daemon's
 * `_log_subscribers` set, this hook just plays its side correctly).
 *
 * The `entries` array is reset to empty every time we disable: the
 * buffered context belongs to the live session, NOT to the next
 * one. Resetting on re-enable too means the very first frame
 * after `subscribe_logs` shows an empty console + the "Subscribing…"
 * pill, which is exactly the perceptual signal we want.
 *
 * Buffer cap
 * ──────────
 * We keep at most `LOG_BUFFER_LIMIT` entries (100). Older entries
 * are dropped silently with no UI signal: this is a live tail
 * surface, not a forensic one, and the user shouldn't be nagged
 * about lines they were never going to read anyway.
 *
 * `id` is monotonic across the entire hook lifetime (it does NOT
 * reset when the buffer wraps): that lets the React `key` stay
 * stable even when the same line arrives twice (different timestamps,
 * different ids).
 */

import { useEffect, useRef, useState } from "react";

import type { RobotSessionHandle } from "@/features/robot-session/useRobotSession";

import {
  categorizeDaemonLine,
  formatClockTime,
  parseDaemonLogLevel,
} from "./parse";
import type { DaemonLogEntry, DaemonLogStreamStatus } from "./types";

/** Max log entries retained in memory. Older entries are dropped. */
export const LOG_BUFFER_LIMIT = 100;

interface UseDaemonLogsOptions {
  session: Pick<RobotSessionHandle, "subscribeLogs">;
  /**
   * Drives subscribe / unsubscribe. The host should pass `isLive`:
   * subscribing too early (before the DataChannel is open) is a
   * silent no-op (the SDK queues the command and it fails the
   * `_dc.readyState !== 'open'` check), so the buffer stays empty
   * until the next viable subscription.
   */
  enabled: boolean;
}

export interface UseDaemonLogsResult {
  entries: DaemonLogEntry[];
  status: DaemonLogStreamStatus;
  /** Last error string emitted by the daemon (`log_stream_error`). */
  errorMessage: string | null;
}

export function useDaemonLogs({
  session,
  enabled,
}: UseDaemonLogsOptions): UseDaemonLogsResult {
  // Pull the subscription function out of the session handle so we
  // can depend on the *function reference* (stable across renders
  // via the host's `useCallback`) instead of the *handle object*
  // (recreated on every `useRobotSession` setState - engineState,
  // webrtcTransport, etc. churn many times per second mid-call).
  //
  // Before this destructure the effect below saw `session` change
  // identity on every parent re-render, which made it tear down
  // and re-subscribe constantly; combined with the `setEntries([])`
  // inside the effect's enable branch, the user saw the log column
  // flicker-clear-refill instead of a smooth append. Stabilising
  // the dep restores incremental append semantics.
  const { subscribeLogs } = session;

  const [entries, setEntries] = useState<DaemonLogEntry[]>([]);
  const [status, setStatus] = useState<DaemonLogStreamStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // `nextIdRef` is incremented on every entry so the React `key`
  // stays stable even across buffer wraps. We deliberately do NOT
  // reset it on subscribe so two consecutive sessions can't ever
  // collide on the same id (which would confuse the virtualised
  // list once we add one).
  const nextIdRef = useRef(0);

  // Stable handler closures so we don't tear down + re-create the
  // subscription on every render of the host (which would cause a
  // window of dropped lines on every parent state change).
  const onLineRef = useRef<((entry: { timestamp: string; line: string }) => void) | null>(null);
  const onErrorRef = useRef<((error: string) => void) | null>(null);

  onLineRef.current = ({ timestamp, line }) => {
    const id = nextIdRef.current++;
    const next: DaemonLogEntry = {
      id,
      rawTimestamp: timestamp,
      clockTime: formatClockTime(Date.now()),
      line,
      level: parseDaemonLogLevel(line),
      category: categorizeDaemonLine(line),
    };
    setStatus("live");
    setEntries((prev) => {
      // Drop the oldest entries silently when we hit the cap. Slicing
      // off the head is O(n) but n=100 is small enough that the
      // browser doesn't notice; a circular buffer with `useRef` would
      // micro-optimise this without changing UX.
      const next_ = [...prev, next];
      return next_.length > LOG_BUFFER_LIMIT
        ? next_.slice(next_.length - LOG_BUFFER_LIMIT)
        : next_;
    });
  };

  onErrorRef.current = (error) => {
    setErrorMessage(error);
    setStatus("error");
    console.warn("[daemon-logs] stream error:", error);
  };

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      setEntries([]);
      setErrorMessage(null);
      return undefined;
    }

    setStatus("subscribing");
    setEntries([]);
    setErrorMessage(null);

    // Wrap through refs so the SDK's subscription survives parent
    // re-renders without us having to re-subscribe (which would
    // momentarily drop lines).
    const unsubscribe = subscribeLogs({
      onLine: (entry) => onLineRef.current?.(entry),
      onError: (error) => onErrorRef.current?.(error),
    });

    return () => {
      try {
        unsubscribe();
      } catch (err) {
        console.warn("[daemon-logs] unsubscribe failed:", err);
      }
    };
  }, [enabled, subscribeLogs]);

  return { entries, status, errorMessage };
}
