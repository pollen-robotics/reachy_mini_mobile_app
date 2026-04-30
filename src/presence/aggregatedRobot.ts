/**
 * `AggregatedRobot` - the single representation of a physical Reachy
 * across all discovery channels.
 *
 * Why this exists
 * ───────────────
 * Before this layer the app maintained 3 parallel lists (BLE devices,
 * HF central robot listings, localhost-tray daemons) keyed by 3
 * independent ids, with no notion of "this BLE device, that central
 * entry, and that loopback row are the same physical robot". Every
 * consumer (the scan screen, the peer-id resolver, the session
 * controller) re-implemented its own ad-hoc matching logic - which
 * worked for the trivial 1-source / 1-robot case and silently broke
 * as soon as the user owned more than one Reachy or stood near a
 * neighbour's robot.
 *
 * The aggregator (`aggregateRobots`) consumes the 3 source lists and
 * produces an array of these objects. Each `AggregatedRobot` is
 * keyed on the daemon's persistent `install_id` (or a synthetic key
 * for legacy / pre-install_id entries), and carries every transport
 * we found it on. The UI renders one card per `AggregatedRobot`; the
 * session entry-point function `pickBestTarget` derives a
 * `ConnectionTarget` from one of the carried transports.
 *
 * Identity guarantees
 * ───────────────────
 * - When `installId` is non-null, it is the **same UUID hex** the
 *   daemon writes in its persistent `daemon.json`, advertises in BLE
 *   (truncated to a 16-char prefix), and publishes to central via
 *   `setPeerStatus.meta.install_id`. Two `AggregatedRobot`s with the
 *   same `installId` are the same physical Reachy, period.
 * - When `installId` is `null` the aggregator could not anchor the
 *   row on a strong identifier (legacy daemon, malformed BLE advert,
 *   …). In that case `transports` is guaranteed to hold exactly one
 *   entry: the source we observed it on. We never fuse two
 *   anchorless rows together - it would be guesswork.
 *
 * What a transport carries
 * ────────────────────────
 * `RobotTransport` keeps the source-specific payload intact (the
 * full BLE device, the full central entry, the full localhost info)
 * so callers that need source-specific bits (RSSI, central peer_id,
 * loopback host) don't need a side channel. The aggregator never
 * normalises away information.
 */
import type { ReachyBleDevice } from '../ble/useBleSession';
import type {
  CentralRobotEntry,
  RobotHealth,
  RobotKind,
} from '../auth/fetchRobotsFromCentral';
import type { LocalDaemonInfo } from './localDaemonSource';

/**
 * The discovery channels we can find a robot on. Keep this union
 * additive: a future `mdns-lan-http` channel adds a new variant
 * without touching the consumers (they do exhaustive checks on the
 * `type` discriminator).
 */
export type RobotTransport =
  | { type: 'localhost'; daemon: LocalDaemonInfo }
  | { type: 'ble'; device: ReachyBleDevice }
  | { type: 'central'; entry: CentralRobotEntry };

/** Type guard helpers - kept here so consumers don't re-discriminate. */
export function isLocalhostTransport(
  t: RobotTransport,
): t is Extract<RobotTransport, { type: 'localhost' }> {
  return t.type === 'localhost';
}
export function isBleTransport(
  t: RobotTransport,
): t is Extract<RobotTransport, { type: 'ble' }> {
  return t.type === 'ble';
}
export function isCentralTransport(
  t: RobotTransport,
): t is Extract<RobotTransport, { type: 'central' }> {
  return t.type === 'central';
}

/**
 * Aggregated view of a single physical robot.
 *
 * Field stability:
 *   - `installId`, `transports[*]` are stable across snapshots when
 *     the underlying source data is unchanged (referential equality
 *     not guaranteed - structural equality is).
 *   - `health`, `errorCode`, `lastSeenAt`, `rssi` track the latest
 *     observation. Consumers that animate transitions (e.g. fade-in
 *     a new transport chip) should diff against the previous
 *     snapshot.
 */
export interface AggregatedRobot {
  /**
   * Stable per-install UUID (full 32 hex chars, no dashes), or
   * `null` if no source provided one. Anchors fusion across
   * transports and survives daemon restarts / network changes.
   */
  installId: string | null;
  /**
   * Synthetic key used by the aggregator to store this robot in its
   * internal map. UI consumers should use this as React key prop.
   * Stable across snapshots for the same physical robot.
   */
  key: string;
  /**
   * Display name picked from the highest-priority source that has
   * one. Priority: central > localhost > BLE. Falls back to a
   * generic "Reachy Mini" if no source named the robot.
   */
  displayName: string;
  /**
   * Hardware kind. Derived primarily from `central.meta.kind` (the
   * authoritative source, daemon-published). When central isn't
   * available we fall back to per-transport defaults documented in
   * `localDaemonSource.ts` (localhost ⇒ tray) or assume
   * `'robot'` for BLE-only entries (the tray doesn't broadcast BLE).
   */
  kind: RobotKind;
  /**
   * Wireless-version flag (USB vs Wi-Fi):
   *   - `true`  ⇒ Wi-Fi-paired robot.
   *   - `false` ⇒ USB / wired (also the tray default).
   *   - `null`  ⇒ unknown (no source provided the bit; expect this
   *     for BLE-only entries where the daemon hasn't reached
   *     central yet).
   */
  wirelessVersion: boolean | null;
  /**
   * Aggregated health. Reduced from per-transport values:
   *   - 'error'    if any transport reports `error`.
   *   - 'degraded' else if any transport reports `degraded`.
   *   - 'ok'       else if at least one transport reports `ok`.
   *   - 'unknown'  else (no transport surfaced a health value yet).
   *
   * Rationale: a robot is only as healthy as its worst observed
   * channel. A daemon screaming `error` on central while BLE is
   * still alive points to a real fault that the user needs to see.
   */
  health: RobotHealth;
  /**
   * Daemon-side error code (e.g. `'no_backend'`, `'backend_not_ready'`)
   * when `health === 'error'`. Always `null` on `ok` / `degraded` /
   * `unknown`.
   */
  errorCode: string | null;
  /**
   * Whether the row should be rendered. `false` for hidden rows
   * (currently: tray daemons in `error` state, see
   * `centralEntryPolicy`). UI should drop the row entirely.
   */
  visible: boolean;
  /**
   * Whether the row should refuse taps. `true` when no transport is
   * usable for a session (e.g. all transports reported `error`). UI
   * should grey the card and surface the `errorCode` caption.
   */
  disabled: boolean;
  /**
   * All discovery channels we found this robot on, ordered by
   * preference. The first entry is the one `pickBestTarget` will
   * select unless the consumer overrides the choice. Order:
   * `localhost` ≻ `ble` ≻ `central` (see `pickBestTarget` for
   * rationale).
   */
  transports: RobotTransport[];
  /**
   * Epoch ms of the latest observation across all transports. Used
   * for sorting (most-recent first), tie-breaking, and stale-row
   * fading. `null` only on synthetic / mock rows.
   */
  lastSeenAt: number | null;
  /**
   * BLE signal strength (RSSI) when a BLE transport is present.
   * `null` otherwise. Convenience field so the UI doesn't have to
   * dig into `transports`.
   */
  rssi: number | null;
}
