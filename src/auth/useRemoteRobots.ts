/**
 * Reactive view of "what robots does Hugging Face central know about
 * for this user, right now?".
 *
 * Wraps `fetchRobotsFromCentral` with token-aware lifecycle:
 *
 *   - `token === null`        → state: 'no-token' (UI shows sign-in CTA).
 *   - `token` set, first load → state: 'loading'.
 *   - Fetch ok                → state: 'ready' with `robots[]`.
 *   - Fetch failed            → state: 'error' with `reason`.
 *
 * The fetch retriggers automatically when:
 *   - the token changes,
 *   - `pollMs` elapses (default: 30 s, off when `pollMs <= 0`),
 *   - the consumer calls `refresh()`.
 *
 * Why a dedicated hook rather than calling the fetcher inline:
 *   - Multiple screens want the same list (the unified ScanScreen and
 *     RemoteScreen's pick step). Centralising avoids duplicate network
 *     requests and lets us share the freshness window (initial fetch
 *     stays valid across navigation).
 *   - Coming back to the discovery screen after a BLE session must
 *     show the previous remote list immediately (no flash of empty);
 *     keeping `robots` cached on the hook achieves that.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '../logger';
import {
  fetchRobotsFromCentral,
  type CentralRobotEntry,
} from './fetchRobotsFromCentral';

const logger = createLogger('central.poll');

export type RemoteRobotsState =
  | { kind: 'no-token' }
  | { kind: 'loading'; robots: CentralRobotEntry[] }
  | { kind: 'ready'; robots: CentralRobotEntry[] }
  | { kind: 'error'; robots: CentralRobotEntry[]; reason: string };

export interface UseRemoteRobotsResult {
  state: RemoteRobotsState;
  /** Trigger an immediate refresh. No-op when there is no token. */
  refresh: () => Promise<void>;
}

const DEFAULT_POLL_MS = 30_000;

export function useRemoteRobots(
  token: string | null,
  opts: { pollMs?: number } = {},
): UseRemoteRobotsResult {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  // Keep the last successful list across token-equal re-renders so the
  // UI doesn't blank out between polls. We move it across state
  // transitions explicitly via `previousRobots`.
  const [state, setState] = useState<RemoteRobotsState>(() =>
    token ? { kind: 'loading', robots: [] } : { kind: 'no-token' },
  );

  // Bumped on every fetch so a late-resolving previous request can't
  // overwrite the current state.
  const fetchIdRef = useRef(0);

  const runFetch = useCallback(
    async (currentToken: string, previousRobots: CentralRobotEntry[]) => {
      const id = ++fetchIdRef.current;
      const t0 = performance.now();
      logger.debug('start');
      setState({ kind: 'loading', robots: previousRobots });
      const result = await fetchRobotsFromCentral(currentToken);
      if (id !== fetchIdRef.current) {
        logger.debug('superseded');
        return;
      }
      const latencyMs = Math.round(performance.now() - t0);
      if (!result.ok) {
        logger.warn('error', {
          reason: result.reason ?? 'unknown',
          latency_ms: latencyMs,
        });
        setState({
          kind: 'error',
          robots: previousRobots,
          reason: result.reason ?? 'Unknown error',
        });
        return;
      }
      logger.info('success', {
        robot_count: result.robots.length,
        latency_ms: latencyMs,
      });
      setState({ kind: 'ready', robots: result.robots });
    },
    [],
  );

  // The previous list is the one currently in state when we trigger a
  // new fetch; capture it via a ref so refreshes don't depend on
  // `state` (avoids re-creating callbacks).
  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = useCallback(async (): Promise<void> => {
    if (!token) return;
    const previous =
      stateRef.current.kind === 'no-token'
        ? []
        : stateRef.current.robots;
    await runFetch(token, previous);
  }, [token, runFetch]);

  useEffect(() => {
    if (!token) {
      // Cancel any in-flight fetch, drop everything.
      fetchIdRef.current += 1;
      setState({ kind: 'no-token' });
      return;
    }

    // Token (re-)appeared: do an initial fetch keeping any previous
    // list as a soft cache so the UI doesn't blank.
    const previous =
      stateRef.current.kind === 'no-token' ? [] : stateRef.current.robots;
    void runFetch(token, previous);

    if (pollMs <= 0) return;
    const handle = window.setInterval(() => {
      const prev =
        stateRef.current.kind === 'no-token'
          ? []
          : stateRef.current.robots;
      void runFetch(token, prev);
    }, pollMs);
    return () => window.clearInterval(handle);
  }, [token, pollMs, runFetch]);

  return { state, refresh };
}
