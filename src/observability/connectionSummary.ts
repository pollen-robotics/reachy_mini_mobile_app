/**
 * connectionSummary - single source of truth for "what does this
 * session look like right now?".
 *
 * Why this exists
 * ───────────────
 * The session has at least 7 independent observable signals:
 *   - FSM phase + activeStep
 *   - Engine `AppState` (connecting / starting / listening / …)
 *   - Daemon HTTP probe state
 *   - WebRTC ICE transport classification (lan / direct / relay)
 *   - Peer id resolution status (central match)
 *   - Motion store (desired / current / lastOutcome)
 *   - Folded session health (healthy / degraded / lost)
 *
 * Today, debugging "why is the session stuck at 80% bring-up?"
 * means correlating scrolls of unrelated info/warn lines from a
 * half-dozen logger namespaces and reconstructing the timeline by
 * hand. This module folds the seven signals into ONE structured
 * snapshot and emits ONE log line per change (debounced 200 ms),
 * so a single
 *
 *   localStorage.setItem('log:filter', 'connection');
 *
 * is enough to follow the entire lifecycle of a connection
 * attempt in chronological order.
 *
 * Design contract
 * ───────────────
 * - Singleton store. The session controller is the *only* writer;
 *   subscribers (UI overlays, dev tools) just observe.
 * - Snapshot equality is JSON-fingerprint based, so consecutive
 *   idempotent writes are no-ops both for subscribers and for the
 *   logger.
 * - `notify()` only fires on actual content change, so React
 *   `useSyncExternalStore` consumers don't re-render uselessly.
 * - Logging is debounced 200 ms: a burst of correlated updates
 *   collapses to one log line carrying the final state. The
 *   tradeoff is a small delay before transitions appear in the
 *   console; in practice phases settle in <1 s so it's invisible.
 * - `reset()` is the session boundary: callers MUST call it on
 *   screen mount so a fresh session doesn't inherit the previous
 *   one's snapshot.
 */
import { createLogger } from '../logger';

const logger = createLogger('connection');

// ─── Public types ────────────────────────────────────────────────────

/**
 * Subset of `AppState` we surface here. Kept as a free-form string
 * so this module doesn't pull a hard import on `conversation-engine`
 * (the controller does the conversion).
 */
export type EngineLabel = string;

/** Mirror of `DaemonProbeState['kind']` from `daemon/useDaemonStatus`. */
export type DaemonLabel = 'idle' | 'probing' | 'ok' | 'error';

/** ICE classification, mirror of `conversation-engine.ts` `TransportLabel`. */
export type TransportLabel =
  | 'unknown'
  | 'checking'
  | 'lan'
  | 'direct'
  | 'relay';

/** Folded session health bucket, mirror of `useSessionHealth`. */
export type SessionHealthLabel =
  | 'unknown'
  | 'connecting'
  | 'healthy'
  | 'degraded'
  | 'lost';

/** Coarse motion store state, mirror of `RobotState`. */
export type MotionStateLabel = 'unknown' | 'awake' | 'sleeping';

export interface ConnectionSummaryTarget {
  /**
   * `local`     : BLE-discovered, LAN-HTTP transport.
   * `localhost` : daemon answering on `127.0.0.1` (typically the
   *               desktop tray on the same Mac).
   * `remote`    : HF central WebRTC.
   */
  kind: 'local' | 'localhost' | 'remote';
  /** Stable identity. BLE address (local), `localhost:<host>` (localhost), peer id (remote). */
  id: string | null;
  /** Display name. */
  name: string | null;
}

export interface ConnectionSummary {
  /** Wall clock ms of the last semantic change (excluded from fingerprint). */
  ts: number;
  /** App-wide trace id; pairs with daemon-side `X-Trace-Id`. */
  traceId: string | null;
  /** What the user is connecting to. */
  target: ConnectionSummaryTarget | null;
  /** Lifecycle phase from the session FSM. */
  phase: string | null;
  /** Substep index within the current phase. */
  step: number;
  /** Engine `AppState`. */
  engine: EngineLabel | null;
  /** Daemon probe verdict. */
  daemon: DaemonLabel;
  /** Active ICE transport. */
  transport: TransportLabel;
  /** Central peer-id resolution. */
  peerId: { value: string | null; resolved: boolean };
  /** Motion store summary. */
  motion: {
    desired: MotionStateLabel | null;
    current: MotionStateLabel | null;
    lastOutcome: string | null;
  };
  /** Folded session health. */
  health: SessionHealthLabel;
}

const INITIAL: ConnectionSummary = {
  ts: 0,
  traceId: null,
  target: null,
  phase: null,
  step: 0,
  engine: null,
  daemon: 'idle',
  transport: 'unknown',
  peerId: { value: null, resolved: false },
  motion: { desired: null, current: null, lastOutcome: null },
  health: 'unknown',
};

// ─── Internal state ──────────────────────────────────────────────────

let snapshot: ConnectionSummary = { ...INITIAL };
let snapshotFp: string = fingerprint(snapshot);
const subs = new Set<(s: ConnectionSummary) => void>();
let pendingFlush: ReturnType<typeof setTimeout> | null = null;

const FLUSH_DEBOUNCE_MS = 200;

/**
 * Stable serialisation, used for both subscriber dedup and log
 * dedup. `ts` is excluded so an update that doesn't change any
 * meaningful field is a no-op even though Date.now() advanced.
 */
function fingerprint(s: ConnectionSummary): string {
  return JSON.stringify({
    traceId: s.traceId,
    target: s.target,
    phase: s.phase,
    step: s.step,
    engine: s.engine,
    daemon: s.daemon,
    transport: s.transport,
    peerId: s.peerId,
    motion: s.motion,
    health: s.health,
  });
}

function applyChange(next: ConnectionSummary): void {
  const nextFp = fingerprint(next);
  if (nextFp === snapshotFp) return;
  snapshot = next;
  snapshotFp = nextFp;
  for (const sub of subs) sub(snapshot);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (pendingFlush !== null) return;
  pendingFlush = setTimeout(() => {
    pendingFlush = null;
    // applyChange already deduped against the previous snapshot, so
    // every flush corresponds to a real semantic change. We log the
    // entire snapshot rather than a diff so a single log line is
    // self-contained when grepped out of context.
    logger.info('summary', { ...snapshot });
  }, FLUSH_DEBOUNCE_MS);
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Replace a single field in the snapshot. Idempotent: if the new
 * value fingerprints identically (===-equal for primitives, deep
 * equal via JSON for objects), nothing happens.
 */
export function set<K extends keyof ConnectionSummary>(
  key: K,
  value: ConnectionSummary[K],
): void {
  applyChange({ ...snapshot, [key]: value, ts: Date.now() });
}

/**
 * Batch replace several correlated fields. Equivalent to N `set`
 * calls but emits at most one notify + one debounced log.
 */
export function update(patch: Partial<ConnectionSummary>): void {
  applyChange({ ...snapshot, ...patch, ts: Date.now() });
}

/**
 * Reset to the initial snapshot. Cancels any pending log flush so
 * the previous session's tail doesn't leak into the next one's
 * timeline. Call this on screen mount AND on unmount.
 */
export function reset(): void {
  if (pendingFlush !== null) {
    clearTimeout(pendingFlush);
    pendingFlush = null;
  }
  snapshot = { ...INITIAL };
  snapshotFp = fingerprint(snapshot);
  for (const sub of subs) sub(snapshot);
}

/** Read the current snapshot synchronously. */
export function get(): ConnectionSummary {
  return snapshot;
}

/**
 * Subscribe to changes. The subscriber is invoked once immediately
 * with the current snapshot, then on every semantic change.
 */
export function subscribe(fn: (s: ConnectionSummary) => void): () => void {
  subs.add(fn);
  fn(snapshot);
  return () => {
    subs.delete(fn);
  };
}

// ─── React-friendly bindings ─────────────────────────────────────────
// Kept here (rather than in a separate hook file) so consumers don't
// need to wire useSyncExternalStore boilerplate themselves. The
// implementation is intentionally tiny: any UI surface that needs the
// snapshot just calls `useConnectionSummary()`.

import { useSyncExternalStore } from 'react';

export function useConnectionSummary(): ConnectionSummary {
  return useSyncExternalStore(
    (cb) => subscribe(cb),
    () => snapshot,
    () => snapshot,
  );
}
