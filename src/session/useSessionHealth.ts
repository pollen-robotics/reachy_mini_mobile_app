/**
 * `useSessionHealth(probe, engineState, opts)` - joined health
 * view over the daemon HTTP probe and the SDK app state.
 *
 * Why a separate hook
 * ───────────────────
 * Both signals already exist (`useDaemonStatus` for the daemon,
 * `engineState` for the SDK). The screen needs a single answer to
 * "is the session alive enough to talk?" so the chrome around the
 * conversation can react to flaps without each component rolling
 * its own bookkeeping. This hook folds the two signals into a
 * stable `SessionHealth` value, applies a small grace period before
 * declaring the session lost, and emits structured events on every
 * transition for debug logs.
 *
 * What "lost" means here
 * ──────────────────────
 * - Daemon probe in `error` state for >`graceMs` while we were
 *   previously healthy. Transient flaps below the grace are
 *   reported as `degraded` (banner stays soft).
 * - Engine state went to `error` or back to `signed-out` after we
 *   had been live. Treated as immediate eviction.
 * - The screen is responsible for deciding what to do (retry
 *   probe, surface fallback CTA, force back). This hook only
 *   reports.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { createLogger } from '../logger';
import {
  defaultDiagnosticMessage,
  type ConnectionDiagnostic,
} from '../presence/types';

import type { SessionEvent, SessionHealth, SessionHealthStatus } from './types';
import type { AppState } from '../conversation/conversation-engine';
import type { DaemonProbeState } from '../daemon/useDaemonStatus';

const logger = createLogger('session.health');

/** Engine states that count as "healthy enough to talk". */
const LIVE_ENGINE_STATES: ReadonlySet<AppState> = new Set([
  'connected',
  'listening',
  'user-speaking',
  'processing',
  'ai-speaking',
]);

/** Engine states that mean we never reached live. */
const TRANSIENT_ENGINE_STATES: ReadonlySet<AppState> = new Set([
  'signed-out',
  'authenticated',
  'connecting',
  'auto-selecting',
  'starting',
]);

/**
 * Soft degraded state must persist this long before being escalated
 * to `lost`. The value is short enough that genuinely lost sessions
 * surface quickly, long enough that one missed poll doesn't trigger
 * a banner storm.
 */
const DEFAULT_GRACE_MS = 6_000;

export interface UseSessionHealthOptions {
  /**
   * Override the lost-after-degraded grace. 0 disables grace and
   * makes the first error escalate immediately (used by tests).
   */
  graceMs?: number;
  /**
   * Optional sink for structured events. The hook always emits via
   * the logger; this callback is for surfacing events to a future
   * UI banner/toast layer or a telemetry pipeline.
   */
  onEvent?: (event: SessionEvent) => void;
}

export function useSessionHealth(
  probe: DaemonProbeState,
  engineState: AppState | null,
  opts: UseSessionHealthOptions = {},
): SessionHealth {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  const [status, setStatus] = useState<SessionHealthStatus>('connecting');
  const [diagnostic, setDiagnostic] = useState<ConnectionDiagnostic | null>(
    null,
  );
  const [lastHealthyAt, setLastHealthyAt] = useState<number | null>(null);

  // Track when the current degraded streak started so we can escalate
  // to `lost` only after `graceMs`. Reset on healthy.
  const degradedSinceRef = useRef<number | null>(null);
  // Hold the most recent diagnostic for use when escalating.
  const pendingDiagnosticRef = useRef<ConnectionDiagnostic | null>(null);

  // Remember the previous status so we can emit transition events.
  const prevStatusRef = useRef<SessionHealthStatus>('connecting');

  // Stable reference to onEvent so the effect deps stay simple.
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;
  const emit = (event: SessionEvent): void => {
    logger.info(event.kind, { ...event });
    onEventRef.current?.(event);
  };

  // Convert a probe error into a typed diagnostic. We only have a
  // free-form string from `useDaemonStatus`, so the classification
  // is best-effort. The webrtc-during-handshake message is special-
  // cased so it stays in `connecting` rather than triggering a
  // "lost" banner during normal startup.
  const classify = (
    probe: DaemonProbeState,
  ): { connecting: boolean; diagnostic: ConnectionDiagnostic | null } => {
    if (probe.kind === 'error') {
      const msg = probe.message;
      if (/connecting to robot through webrtc/i.test(msg)) {
        return { connecting: true, diagnostic: null };
      }
      const httpMatch = /HTTP (\d{3})/i.exec(msg);
      if (httpMatch) {
        const status = Number(httpMatch[1]);
        if (status >= 500) {
          return {
            connecting: false,
            diagnostic: {
              kind: 'http_5xx',
              status,
              message: msg,
            },
          };
        }
        return {
          connecting: false,
          diagnostic: { kind: 'http_4xx', status, message: msg },
        };
      }
      if (/timed out|timeout/i.test(msg)) {
        return {
          connecting: false,
          diagnostic: {
            kind: 'timeout',
            message: defaultDiagnosticMessage('timeout'),
          },
        };
      }
      return {
        connecting: false,
        diagnostic: {
          kind: 'network_error',
          message: msg || defaultDiagnosticMessage('network_error'),
        },
      };
    }
    return { connecting: false, diagnostic: null };
  };

  // Re-evaluate health on every probe / engine change. We don't run
  // a wall clock here: the next probe tick or engine transition
  // produces a render and we re-check; if neither fires for >graceMs
  // it would mean the probe stopped polling, which is a bug
  // upstream. We additionally schedule a watchdog timer when the
  // session is degraded so escalation to `lost` doesn't wait for
  // the next external tick.
  useEffect(() => {
    let nextStatus: SessionHealthStatus = status;
    let nextDiagnostic: ConnectionDiagnostic | null = diagnostic;

    const probeOk = probe.kind === 'ok';
    const engineLive =
      engineState !== null && LIVE_ENGINE_STATES.has(engineState);
    const engineTransient =
      engineState === null || TRANSIENT_ENGINE_STATES.has(engineState);
    const engineDead = engineState === 'error';

    if (engineDead) {
      // Hard failure from the SDK, not subject to grace. Treat as
      // eviction: we no longer have a working session, regardless
      // of the probe.
      nextStatus = 'lost';
      nextDiagnostic = {
        kind: 'unknown',
        message: 'The conversation engine reported an error.',
      };
      degradedSinceRef.current = null;
      pendingDiagnosticRef.current = null;
    } else if (probeOk && engineLive) {
      nextStatus = 'healthy';
      nextDiagnostic = null;
      degradedSinceRef.current = null;
      pendingDiagnosticRef.current = null;
      setLastHealthyAt(Date.now());
    } else if (probeOk && engineTransient) {
      // Probe is fine, engine is on its way up; this is normal
      // startup chrome, not a problem.
      nextStatus = 'connecting';
      nextDiagnostic = null;
    } else {
      const { connecting, diagnostic: classified } = classify(probe);
      if (connecting) {
        nextStatus = 'connecting';
        nextDiagnostic = null;
      } else if (status === 'healthy' || status === 'degraded') {
        // We had a healthy session previously: enter the grace
        // window. The watchdog below escalates to `lost` if the
        // probe doesn't recover.
        if (degradedSinceRef.current === null) {
          degradedSinceRef.current = Date.now();
        }
        pendingDiagnosticRef.current = classified;
        const elapsed = Date.now() - degradedSinceRef.current;
        if (elapsed >= graceMs) {
          nextStatus = 'lost';
          nextDiagnostic = classified;
        } else {
          nextStatus = 'degraded';
          nextDiagnostic = classified;
        }
      } else {
        // We never reached healthy in this session: don't show a
        // "session lost" banner during initial connection - the
        // existing handshake error path owns that UX.
        nextStatus = 'connecting';
        nextDiagnostic = null;
      }
    }

    if (nextStatus !== status) {
      const ts = Date.now();
      const previous = prevStatusRef.current;
      if (nextStatus === 'healthy' && previous !== 'healthy') {
        if (previous === 'lost' || previous === 'degraded') {
          emit({
            kind: 'session.recovered',
            ts,
            downtimeMs:
              degradedSinceRef.current !== null
                ? ts - degradedSinceRef.current
                : 0,
          });
        } else {
          emit({ kind: 'session.up', ts });
        }
      }
      if (nextStatus === 'degraded' && previous !== 'degraded') {
        emit({
          kind: 'session.degraded',
          ts,
          reason: nextDiagnostic?.message ?? 'Probe error',
        });
      }
      if (nextStatus === 'lost' && previous !== 'lost') {
        const reason =
          nextDiagnostic?.message ?? 'Session lost without diagnostic';
        if (engineDead) {
          emit({ kind: 'session.evicted', ts, reason });
        } else {
          emit({ kind: 'session.lost', ts, reason });
        }
      }
      prevStatusRef.current = nextStatus;
      setStatus(nextStatus);
    }
    if (nextDiagnostic !== diagnostic) {
      setDiagnostic(nextDiagnostic);
    }
  }, [probe, engineState, graceMs, status, diagnostic]);

  // Watchdog: when degraded, schedule the escalation tick so we
  // don't wait for the next probe to fire. This is a no-op when
  // healthy/connecting/lost.
  useEffect(() => {
    if (status !== 'degraded') return;
    if (degradedSinceRef.current === null) return;
    const elapsed = Date.now() - degradedSinceRef.current;
    const remaining = Math.max(50, graceMs - elapsed);
    const handle = window.setTimeout(() => {
      // Re-evaluate by triggering a state set that mirrors the
      // current value; the main effect above will pick up the new
      // elapsed value and escalate. We use a fresh ref check rather
      // than re-running the classification here to keep the source
      // of truth in one place.
      if (degradedSinceRef.current === null) return;
      const nowElapsed = Date.now() - degradedSinceRef.current;
      if (nowElapsed >= graceMs) {
        prevStatusRef.current = 'lost';
        emit({
          kind: 'session.lost',
          ts: Date.now(),
          reason:
            pendingDiagnosticRef.current?.message ??
            'Session lost without diagnostic',
        });
        setStatus('lost');
        setDiagnostic(pendingDiagnosticRef.current);
      }
    }, remaining);
    return () => window.clearTimeout(handle);
  }, [status, graceMs]);

  return useMemo(
    () => ({ status, diagnostic, lastHealthyAt }),
    [status, diagnostic, lastHealthyAt],
  );
}
