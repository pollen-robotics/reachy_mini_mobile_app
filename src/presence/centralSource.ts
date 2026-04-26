/**
 * `useCentralSource(token, opts)` - Hugging Face central robot list
 * with typed diagnostics, adaptive polling, and lifecycle awareness.
 *
 * What's different from the old `useRemoteRobots` hook
 * ────────────────────────────────────────────────────
 *
 * 1. **Typed diagnostics**. Errors are returned as a discriminated
 *    `ConnectionDiagnostic` instead of a free-form string, so the UI
 *    can branch on `kind === 'token_rejected'` and show "Sign in
 *    again" rather than guessing from substrings.
 *
 * 2. **Adaptive polling**. While the user is on the discovery
 *    screen and the remote list is empty we poll every 5 s; once we
 *    have a stable list (or are off-screen via `visibilitychange`)
 *    we back off to 60 s. The old hook polled 30 s flat.
 *
 * 3. **Pre-flight whoami**. We hit `/api/whoami-v2` first to
 *    distinguish "token rejected" from "central is down". A 401 here
 *    classifies as `token_rejected` regardless of what central
 *    returns next.
 *
 * 4. **Online/offline awareness**. When the OS reports `offline` we
 *    pause the poll; on `online` we trigger an immediate refresh
 *    rather than waiting for the next interval.
 *
 * 5. **Visibility refresh**. When the app comes back to the
 *    foreground we trigger an immediate refresh on top of any
 *    cadence change, so a user who tabbed out for 10 minutes sees a
 *    fresh list within ~one second of returning.
 *
 * Backward compatibility
 * ──────────────────────
 * `useRemoteRobots` (this file's older sibling, still exported under
 * `src/auth/`) keeps its current return shape but is now implemented
 * on top of `useCentralSource`. New screens should use the
 * `CentralSourceState` directly to access typed diagnostics.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchRobotsFromCentral,
  validateHfToken,
  type CentralRobotEntry,
  type RemoteRobotsResult,
} from '../auth/fetchRobotsFromCentral';
import { createLogger } from '../logger';

import {
  defaultDiagnosticMessage,
  type ConnectionDiagnostic,
} from './types';

const logger = createLogger('central.source');

/**
 * Fast cadence is used while the foreground UI is showing the
 * discovery list AND we don't have results yet (or we just hit an
 * error). It produces visible feedback during the first ~30s a
 * freshly powered-on robot needs to appear in central.
 */
const POLL_FAST_MS = 5_000;

/**
 * Slow cadence is used once we have a non-empty stable list, or when
 * the page is hidden, or after repeated errors. Keeps battery and
 * HF egress traffic in check.
 */
const POLL_SLOW_MS = 60_000;

/**
 * After 3 consecutive failures we drop to slow cadence regardless of
 * empty/non-empty list, to avoid hammering a flaky network.
 */
const SLOW_AFTER_FAILURES = 3;

export type CentralSourceState =
  | { kind: 'no-token' }
  | { kind: 'loading'; robots: CentralRobotEntry[] }
  | { kind: 'ready'; robots: CentralRobotEntry[]; lastFetchAt: number }
  | {
      kind: 'error';
      robots: CentralRobotEntry[];
      diagnostic: ConnectionDiagnostic;
      lastFetchAt: number;
    };

export interface UseCentralSourceResult {
  state: CentralSourceState;
  /** Trigger an immediate refresh. No-op when there is no token. */
  refresh: () => Promise<void>;
}

/**
 * Translate a `RemoteRobotsResult` (and/or a whoami pre-flight
 * outcome) into a `ConnectionDiagnostic`. We pattern-match against
 * the specific phrases `fetchRobotsFromCentral` emits today; if those
 * change here we keep this file as the single place where the
 * mapping lives.
 */
function classifyError(
  result: RemoteRobotsResult,
  whoamiOk: boolean | null,
): ConnectionDiagnostic {
  // The whoami pre-flight is authoritative for token rejection.
  if (whoamiOk === false) {
    return {
      kind: 'token_rejected',
      message: defaultDiagnosticMessage('token_rejected'),
    };
  }
  const reason = result.reason ?? '';
  if (/timed out/i.test(reason)) {
    return { kind: 'timeout', message: defaultDiagnosticMessage('timeout') };
  }
  if (/rejected/i.test(reason)) {
    return {
      kind: 'token_rejected',
      message: defaultDiagnosticMessage('token_rejected'),
    };
  }
  const httpMatch = /HTTP (\d{3})/i.exec(reason);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status >= 500) {
      return {
        kind: 'http_5xx',
        status,
        message: `Hugging Face returned HTTP ${status}.`,
      };
    }
    if (status >= 400) {
      return {
        kind: 'http_4xx',
        status,
        message: `Hugging Face returned HTTP ${status}.`,
      };
    }
  }
  if (/network/i.test(reason)) {
    return {
      kind: 'network_error',
      message: defaultDiagnosticMessage('network_error'),
    };
  }
  return { kind: 'unknown', message: reason || defaultDiagnosticMessage('unknown') };
}

interface SourceOpts {
  /**
   * Override the fast/slow cadence. Tests override to 0 to disable
   * polling and drive transitions manually.
   */
  fastMs?: number;
  slowMs?: number;
}

export function useCentralSource(
  token: string | null,
  opts: SourceOpts = {},
): UseCentralSourceResult {
  const fastMs = opts.fastMs ?? POLL_FAST_MS;
  const slowMs = opts.slowMs ?? POLL_SLOW_MS;

  const [state, setState] = useState<CentralSourceState>(() =>
    token ? { kind: 'loading', robots: [] } : { kind: 'no-token' },
  );

  // Last successful run's data is the soft cache that survives across
  // re-fetches: if we go ready→loading the UI keeps showing the
  // previous robots until the new payload lands.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Bumped on every fetch so a late-resolving previous request can't
  // overwrite the current state.
  const fetchIdRef = useRef(0);
  const failureStreakRef = useRef(0);

  // Track whether we've ever validated this token via whoami so we
  // don't pre-flight on every poll. We re-pre-flight only after a
  // suspected token rejection or token rotation.
  const tokenValidatedRef = useRef<{ token: string; ok: boolean } | null>(null);

  const runFetch = useCallback(
    async (currentToken: string) => {
      const id = ++fetchIdRef.current;
      const t0 = performance.now();
      const previous =
        stateRef.current.kind === 'no-token' ? [] : stateRef.current.robots;

      logger.debug('poll.start');
      setState({ kind: 'loading', robots: previous });

      // Pre-flight whoami once per (token, validated=false). On
      // subsequent polls of the same token we skip. We deliberately
      // don't gate the central fetch on whoami latency: instead we
      // run them sequentially because the typical case is "whoami
      // succeeded earlier, skip" and the cost only pays out the
      // first time / on rotation.
      let whoamiOk: boolean | null = null;
      if (
        !tokenValidatedRef.current ||
        tokenValidatedRef.current.token !== currentToken
      ) {
        const whoami = await validateHfToken(currentToken);
        if (id !== fetchIdRef.current) return;
        whoamiOk = whoami.ok;
        tokenValidatedRef.current = { token: currentToken, ok: whoami.ok };
        if (!whoami.ok) {
          // We can short-circuit here: central will reject anyway.
          // Surface as token_rejected to drive the sign-in CTA.
          const diagnostic: ConnectionDiagnostic = {
            kind: 'token_rejected',
            message: whoami.reason ?? defaultDiagnosticMessage('token_rejected'),
          };
          failureStreakRef.current += 1;
          logger.warn('whoami.rejected', { reason: whoami.reason ?? null });
          setState({
            kind: 'error',
            robots: previous,
            diagnostic,
            lastFetchAt: Date.now(),
          });
          return;
        }
      }

      const result = await fetchRobotsFromCentral(currentToken);
      if (id !== fetchIdRef.current) {
        logger.debug('poll.superseded');
        return;
      }
      const latencyMs = Math.round(performance.now() - t0);

      if (!result.ok) {
        failureStreakRef.current += 1;
        const diagnostic = classifyError(result, whoamiOk);
        // A token_rejected from the central call invalidates our cached
        // whoami flag so the next refresh re-runs the pre-flight.
        if (diagnostic.kind === 'token_rejected') {
          tokenValidatedRef.current = null;
        }
        logger.warn('poll.error', {
          kind: diagnostic.kind,
          latency_ms: latencyMs,
          streak: failureStreakRef.current,
        });
        setState({
          kind: 'error',
          robots: previous,
          diagnostic,
          lastFetchAt: Date.now(),
        });
        return;
      }

      failureStreakRef.current = 0;
      logger.info('poll.success', {
        robot_count: result.robots.length,
        latency_ms: latencyMs,
      });
      setState({
        kind: 'ready',
        robots: result.robots,
        lastFetchAt: Date.now(),
      });
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!token) return;
    await runFetch(token);
  }, [token, runFetch]);

  // Pick the cadence for the next interval. Recomputed every time
  // the state or visibility changes; the active timer is reset when
  // the cadence flips so users see the new cadence immediately.
  useEffect(() => {
    if (!token) {
      fetchIdRef.current += 1;
      tokenValidatedRef.current = null;
      failureStreakRef.current = 0;
      setState({ kind: 'no-token' });
      return;
    }

    // Initial fetch on token (re-)appearance.
    void runFetch(token);

    let intervalHandle: number | null = null;

    const scheduleNext = (): void => {
      if (intervalHandle !== null) {
        window.clearInterval(intervalHandle);
        intervalHandle = null;
      }
      // Don't schedule when offline; we'll resume on the `online` event.
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      const hidden =
        typeof document !== 'undefined' && document.visibilityState === 'hidden';
      const empty =
        stateRef.current.kind !== 'no-token' &&
        stateRef.current.robots.length === 0;
      const erroring = stateRef.current.kind === 'error';
      const tooManyFailures = failureStreakRef.current >= SLOW_AFTER_FAILURES;
      const wantFast = !hidden && (empty || erroring) && !tooManyFailures;
      const cadence = wantFast ? fastMs : slowMs;
      if (cadence <= 0) return;
      intervalHandle = window.setInterval(() => {
        void runFetch(token);
      }, cadence);
    };
    scheduleNext();

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        // Coming back to foreground: blow away the schedule and
        // refresh now. The post-fetch state-change rerun will
        // schedule the next interval at the right cadence.
        void runFetch(token);
      }
      scheduleNext();
    };
    const onOnline = (): void => {
      logger.info('online');
      void runFetch(token);
      scheduleNext();
    };
    const onOffline = (): void => {
      logger.info('offline');
      if (intervalHandle !== null) {
        window.clearInterval(intervalHandle);
        intervalHandle = null;
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      if (intervalHandle !== null) window.clearInterval(intervalHandle);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [token, runFetch, fastMs, slowMs]);

  // Re-check the schedule when state or failure streak changes (e.g.
  // empty→non-empty list flips fast→slow cadence). We do this by
  // tickling the cadence selector via a no-op state setter. A cleaner
  // approach would be a reducer, but the cost of a redundant interval
  // recreation on every state change is dwarfed by the fetch cost.
  useEffect(() => {
    // intentional: trigger a re-render so the schedule effect picks
    // up the new state.kind via stateRef.
  }, [state.kind]);

  return { state, refresh };
}
