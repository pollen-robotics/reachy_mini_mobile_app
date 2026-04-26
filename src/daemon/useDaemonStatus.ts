import { useCallback, useEffect, useState } from 'react';

import type { RobotClient } from '../robot-client';

/**
 * Minimal shape of `GET /api/daemon/status`. We only read the fields the UI
 * actually displays. Full schema lives in `reachy_mini/src/reachy_mini/daemon`.
 */
export interface DaemonStatus {
  state: 'running' | 'starting' | 'stopped' | 'error' | string;
  version?: string;
}

export type DaemonProbeState =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'ok'; status: DaemonStatus }
  | { kind: 'error'; message: string };

/**
 * Probe `/api/daemon/status` through a transport-agnostic `RobotClient`,
 * with optional polling.
 *
 * - `client === null` → stays `idle` (used while the user has not picked
 *   a robot yet, or while the WebRTC DataChannel hasn't been opened).
 * - On every success we surface the decoded `DaemonStatus`.
 * - On failure we surface the error message so the screen can show a
 *   hint (e.g. "Cannot reach 192.168.1.42:8000 - check you are on the
 *   same WiFi" for LAN, "Daemon not yet reachable through WebRTC" for
 *   remote while the DC is still establishing).
 *
 * Polling is optional: when `pollMs` is provided, we re-probe at that
 * interval. A single pass is triggered on mount and on every `client`
 * change. Callers should memoize their `RobotClient` instance
 * (`useMemo`) so the effect doesn't re-fire on every render.
 *
 * Transport-aware error mapping: when the WebRTC client returns
 * `status: 0, rawBody: 'no active webrtc data channel'`, we surface
 * "connecting…" rather than a hard failure - the DC is being
 * negotiated and a retry on the next poll will likely succeed.
 */
export function useDaemonStatus(
  client: RobotClient | null,
  opts: { pollMs?: number } = {},
): DaemonProbeState {
  const [state, setState] = useState<DaemonProbeState>({ kind: 'idle' });

  const probe = useCallback(
    async (target: RobotClient): Promise<void> => {
      setState(prev =>
        // Don't flip a steady 'ok' back to 'probing' on every poll: the
        // pill / status badge would flicker. Only show 'probing' on the
        // first attempt or after an error.
        prev.kind === 'ok' ? prev : { kind: 'probing' },
      );
      try {
        const resp = await target.fetch<DaemonStatus>('/api/daemon/status');
        if (resp.ok && resp.data) {
          setState({ kind: 'ok', status: resp.data });
          return;
        }
        // status: 0 from the WebRTC transport means "no DC yet";
        // surface a softer message so the UI reads "connecting…"
        // rather than a frightening "HTTP 0".
        if (
          target.transport === 'webrtc-proxy' &&
          resp.status === 0 &&
          /no active webrtc/i.test(resp.rawBody)
        ) {
          setState({
            kind: 'error',
            message: 'Connecting to robot through WebRTC…',
          });
          return;
        }
        setState({
          kind: 'error',
          message: `Daemon responded with HTTP ${resp.status}`,
        });
      } catch (e) {
        setState({ kind: 'error', message: formatError(e) });
      }
    },
    [],
  );

  useEffect(() => {
    if (client === null) {
      setState({ kind: 'idle' });
      return;
    }

    let cancelled = false;
    const runOnce = async () => {
      if (cancelled) return;
      await probe(client);
    };
    void runOnce();

    if (!opts.pollMs) return;
    const interval = window.setInterval(runOnce, opts.pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [client, opts.pollMs, probe]);

  return state;
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) {
    return String((e as { message: unknown }).message);
  }
  return 'Unknown error';
}
