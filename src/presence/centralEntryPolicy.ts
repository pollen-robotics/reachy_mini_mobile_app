/**
 * Presentation policy for a `CentralRobotEntry`.
 *
 * The aggregator (mobile / tray / web) is the only layer allowed to
 * decide what the user sees. Daemons publish facts (`health`,
 * `kind`, `error_code`); central forwards them verbatim; this module
 * derives the row's visibility, interactability, and badge from those
 * facts. Everything else just calls `centralEntryPolicy(entry)`.
 *
 * See `reachy_mini/docs/SIGNALING.md` (section "What lives where").
 *
 * Three cases this collapses for callers:
 *
 * 1. Hide tray daemons with no hardware. A tray is the desktop helper;
 *    a tray that lost its USB robot is not something the user can
 *    pick. We don't even show the row - the daemon will withdraw on
 *    its own after the grace period, so this is just covering the
 *    in-flight gap.
 *
 * 2. Disable hard-error rows but show them. Surfacing the row gives
 *    the user a chance to retry / replug before the central TTL
 *    sweeps it. Tapping is gated.
 *
 * 3. Surface a badge for degraded rows. The user can still connect,
 *    but knows audio/camera is missing.
 */

import {
  extractErrorCode,
  extractHealth,
  extractKind,
  type CentralRobotEntry,
  type RobotHealth,
} from '../auth/fetchRobotsFromCentral';

export type EntryBadge = 'degraded' | 'error';

export interface EntryDisplayPolicy {
  /** When false, the caller must omit the row from the listing. */
  visible: boolean;
  /** When true, taps must be ignored - the robot can't serve a session. */
  disabled: boolean;
  /** UI badge to draw next to the name; null when no badge applies. */
  badge: EntryBadge | null;
  /**
   * Stable error taxonomy bubble to the UI when the row is disabled.
   * Always paired with `disabled === true && badge === 'error'`.
   */
  errorCode: string | null;
  /** Computed once so callers don't re-derive it. */
  health: RobotHealth;
}

/**
 * Single source of truth for "should we show this row, and how?".
 *
 * Defensive on missing fields: a daemon that pre-dates the
 * `meta.health` schema returns `'unknown'` from `extractHealth`, and
 * we treat that as "ok" for backward compatibility (the old
 * always-visible behaviour). New code should branch on the policy
 * fields rather than re-reading `meta` directly so that any future
 * refinement (e.g. quarantine after repeated failures) lands in one
 * place.
 */
export function centralEntryPolicy(
  entry: CentralRobotEntry | undefined,
): EntryDisplayPolicy {
  const health = extractHealth(entry);
  const kind = extractKind(entry);
  const errorCode = extractErrorCode(entry);

  // Tray + error = stale desktop helper after losing its hardware.
  // Hide outright; the daemon's own "withdraw after 30 s" watchdog
  // will catch up shortly even if this client polled too eagerly.
  if (kind === 'tray' && health === 'error') {
    return {
      visible: false,
      disabled: true,
      badge: 'error',
      errorCode,
      health,
    };
  }

  if (health === 'error') {
    return {
      visible: true,
      disabled: true,
      badge: 'error',
      errorCode,
      health,
    };
  }

  if (health === 'degraded') {
    return {
      visible: true,
      disabled: false,
      badge: 'degraded',
      errorCode,
      health,
    };
  }

  // 'ok' or 'unknown' (legacy daemons): full speed ahead.
  return {
    visible: true,
    disabled: false,
    badge: null,
    errorCode: null,
    health,
  };
}

/**
 * Human caption for an error code. Keep this map small and tied to
 * `reachy_mini/daemon/peer_health.py`. Unknown codes return a
 * generic fallback so the UI never shows an empty caption.
 */
export function describeErrorCode(code: string | null): string {
  switch (code) {
    case 'no_backend':
      return 'No hardware connected';
    case 'backend_not_ready':
      return 'Robot is starting up';
    case 'motor_comm':
      return 'Motor communication error';
    case 'media':
      return 'Camera/audio unavailable';
    case 'daemon_fatal':
    case null:
      return 'Robot is unavailable';
    default:
      return `Robot is unavailable (${code})`;
  }
}
