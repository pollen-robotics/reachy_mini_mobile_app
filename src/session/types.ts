/**
 * Session-level types: a stable view over what the conversation
 * engine + transport are currently doing.
 *
 * Where this fits in the stack
 * ────────────────────────────
 * `useDaemonStatus` answers "is the daemon HTTP surface alive
 * right now?". `engineState` answers "what is the SDK app state
 * machine doing?". Neither alone tells the screen "should I show
 * the user a banner because we just lost the connection?".
 *
 * `SessionHealth` is the joined view: it folds the two probes into
 * a single status the UI can render without doing the bookkeeping
 * inline. PR-E (this module) provides the monitor that derives it,
 * and a structured event log so debug sessions don't need to
 * reconstruct timing from screenshots.
 */
import type { ConnectionDiagnostic } from '../presence/types';

/**
 * Coarse health bucket. UI screens should branch on this value
 * rather than peeking into `useDaemonStatus` and the SDK app
 * state independently:
 *
 * - `connecting`  - we're still bringing the session up. Banners
 *                   in this state are "loading" not "warning".
 * - `healthy`     - daemon reachable and engine in a live state.
 *                   No chrome needed.
 * - `degraded`    - one of the probes flapped briefly. We surface
 *                   a soft banner ("reconnecting…") but don't
 *                   tear the session down.
 * - `lost`        - the failure persisted past the grace period.
 *                   The UI should disable controls and show a
 *                   recovery affordance (retry / fallback / back).
 */
export type SessionHealthStatus =
  | 'connecting'
  | 'healthy'
  | 'degraded'
  | 'lost';

export interface SessionHealth {
  status: SessionHealthStatus;
  /** Set when `status` is `degraded` or `lost`. */
  diagnostic: ConnectionDiagnostic | null;
  /** Epoch ms of the last successful probe (daemon+engine both ok). */
  lastHealthyAt: number | null;
}

/**
 * Structured session events. Logged via the standard `session.health`
 * namespace and suitable for forwarding to a future telemetry sink.
 * The `kind` is the discriminator the dev console + grep both use.
 */
export type SessionEvent =
  | { kind: 'session.up'; ts: number }
  | { kind: 'session.degraded'; ts: number; reason: string }
  | { kind: 'session.lost'; ts: number; reason: string }
  | { kind: 'session.recovered'; ts: number; downtimeMs: number }
  | { kind: 'session.evicted'; ts: number; reason: string };
