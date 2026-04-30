/**
 * `aggregateRobots` - the pure function that turns 3 source lists
 * into a single `AggregatedRobot[]` keyed on `install_id`.
 *
 * This module is **pure** by design: no React, no globals, no
 * platform calls. The only inputs are the snapshot value of each
 * source. The only output is a deterministic array, sorted by a
 * stable preference. That makes the whole discovery merge logic
 * unit-testable in isolation - which is the whole point of the
 * extraction.
 *
 * Fusion key
 * ──────────
 * Two snapshot rows are considered the same physical robot iff:
 *   - both expose a non-null `install_id` AND those values match
 *     (BLE only carries a 16-hex prefix, central + localhost carry
 *     the full 32-hex hex; we compare prefixes).
 *
 * Anchorless rows (no `install_id`) are NEVER fused, even if their
 * names match: name collisions are common (default `reachy_mini`)
 * and a wrong fusion is structurally worse than a duplicate row.
 *
 * Transport ordering
 * ──────────────────
 * `transports` inside each `AggregatedRobot` is ordered:
 *   1. `localhost` - tray on this Mac, lowest possible latency, no
 *      external dependency.
 *   2. `ble`       - physical proximity, can also drive Wi-Fi setup
 *      and reads NETWORK_STATUS without internet.
 *   3. `central`   - WebRTC via HF central, works from anywhere
 *      with internet.
 * `pickBestTarget` reuses this order; consumers that want a
 * different policy can re-sort after the fact.
 *
 * Output ordering
 * ───────────────
 * The returned array is sorted:
 *   1. Visible rows before hidden ones.
 *   2. Disabled rows after enabled ones (within visibility tier).
 *   3. Highest-quality best-transport first
 *      (localhost ≻ ble ≻ central).
 *   4. Most-recently-seen first (within the same transport tier).
 *   5. Alphabetical by `displayName` as final tie-breaker.
 *
 * The UI is free to apply additional filters / regroupings on top
 * (e.g. "stick the last-used robot at the top"), but the baseline
 * ordering is stable and self-explanatory.
 */
import {
  extractErrorCode,
  extractHealth,
  extractInstallId,
  extractKind,
  type CentralRobotEntry,
  type RobotHealth,
  type RobotKind,
} from '../auth/fetchRobotsFromCentral';
import type { ReachyBleDevice } from '../ble/useBleSession';

import type {
  AggregatedRobot,
  RobotTransport,
} from './aggregatedRobot';
import { centralEntryPolicy } from './centralEntryPolicy';
import {
  LOCAL_DAEMON_KIND,
  LOCAL_DAEMON_WIRELESS,
  type LocalDaemonInfo,
} from './localDaemonSource';

/** Number of hex chars BLE advertises for the install_id prefix. */
const BLE_INSTALL_ID_PREFIX_LEN = 16;

/** Default display name when no source named the robot. */
const DEFAULT_DISPLAY_NAME = 'Reachy Mini';

/**
 * Maximum age (ms) before a BLE device is considered stale and dropped.
 *
 * The scan runs in 15 s bursts every ~14 s with `preserve: true`, so a
 * fresh device sees its `lastSeenMs` updated every cycle. Three missed
 * cycles (~45 s) means the robot really stopped advertising; we add a
 * small grace margin and round to `60_000` ms so a brief OS-level scan
 * throttle doesn't evict an otherwise-healthy device.
 *
 * Without this filter, `startScanning({ preserve: true })` would
 * accumulate "fossil" rows: a robot we saw once, walked away from,
 * and is now off, would stick around in the list with its last-known
 * advert until app restart - confusing the user with a row that
 * fails on every tap.
 */
const BLE_STALE_AGE_MS = 60_000;

export interface AggregateRobotsInput {
  /** Currently-visible BLE advertisements. */
  bleDevices: readonly ReachyBleDevice[];
  /** HF central listing (post-policy filtering happens inside). */
  centralRobots: readonly CentralRobotEntry[];
  /** Local-loopback daemon, if one answered. */
  localDaemon: LocalDaemonInfo | null;
  /**
   * Override "now" (epoch ms) for deterministic tests. Defaults to
   * `Date.now()` at call time. Production callers leave it unset.
   */
  nowMs?: number;
}

/**
 * Aggregate the 3 sources into a single robot list.
 *
 * Pure: same inputs ⇒ same output, no side effects. Order of inputs
 * inside each list is irrelevant; the function imposes its own
 * deterministic ordering.
 */
export function aggregateRobots(
  input: AggregateRobotsInput,
): AggregatedRobot[] {
  const now = input.nowMs ?? Date.now();
  const bucket = new Map<string, MutableRobot>();

  // Pre-pass A: drop BLE devices that haven't advertised within
  // `BLE_STALE_AGE_MS`. The scanner runs `preserve: true` so the raw
  // store keeps every device we ever saw; the aggregator is the
  // authority for "what's actually here right now".
  //
  // Devices with `lastSeenMs === null/0` are kept defensively: they
  // came from a code path that didn't stamp a timestamp, so we have
  // no basis to evict them. In practice every store entry stamps it.
  const freshBleDevices = input.bleDevices.filter((d) => {
    if (!d.lastSeenMs) return true;
    return now - d.lastSeenMs <= BLE_STALE_AGE_MS;
  });

  // Pre-pass B: identify physical robots whose authoritative BLE
  // TLV says they are NOT actually reachable over the network
  // (`networkMode === 'hotspot' | 'offline'`). For those, any
  // central listing entry we hold is a STALE TTL artefact: the
  // daemon either lost Wi-Fi or just executed `WIFI_FORGET`, but
  // central's lease (~45 s) plus the sweeper interval (~10 s) means
  // we'll keep seeing the entry for up to ~55 s. The mobile poll
  // cadence (60 s when stable) can stretch the window further.
  //
  // Trusting BLE here is sound: it's a 10 s-refresh local broadcast
  // sourced from the daemon's own `_refresh_network_info`; central
  // is at-best a mirror of older state.
  //
  // We collect the install_id prefixes (16 hex chars) that BLE flags
  // as offline and use the set in the central pass to skip those
  // entries entirely. Filtering at the source keeps the bucket
  // clean (no mid-merge mutation, no stale `wirelessVersion` /
  // `health` from the dropped central).
  const offlineByBlePrefixes = new Set<string>();
  for (const device of freshBleDevices) {
    if (!device.installIdPrefix) continue;
    if (device.networkMode === 'hotspot' || device.networkMode === 'offline') {
      offlineByBlePrefixes.add(
        device.installIdPrefix.toLowerCase().slice(0, BLE_INSTALL_ID_PREFIX_LEN),
      );
    }
  }

  // Pass 1: central. Each row contributes a fully-typed record. We
  // bucket by full install_id when present, and by central peerId
  // otherwise (legacy / pre-install_id producers).
  for (const entry of input.centralRobots) {
    const installId = extractInstallId(entry);
    if (
      installId &&
      offlineByBlePrefixes.has(
        installId.toLowerCase().slice(0, BLE_INSTALL_ID_PREFIX_LEN),
      )
    ) {
      // Skip stale central entry: BLE TLV from the same robot says
      // it's not actually online. The BLE pass below will create a
      // BLE-only bucket that the UI renders as "Setup pending".
      continue;
    }
    const policy = centralEntryPolicy(entry);
    const key = installId
      ? installIdKey(installId)
      : centralOnlyKey(entry);
    const transport: RobotTransport = { type: 'central', entry };
    const central = makeFromCentral(entry, installId, policy, transport);
    bucket.set(key, central);
  }

  // Pass 2: localhost. By the file-header invariants of
  // `localDaemonSource`, this is always the tray on this Mac. We
  // join it onto an existing central bucket via full install_id when
  // the central listing already exposed it; otherwise the localhost
  // gets its own bucket.
  if (input.localDaemon) {
    const ld = input.localDaemon;
    const transport: RobotTransport = { type: 'localhost', daemon: ld };
    const key = ld.installId
      ? installIdKey(ld.installId)
      : localhostOnlyKey(ld);
    const existing = bucket.get(key);
    if (existing) {
      mergeLocalhostInto(existing, ld, transport);
    } else {
      bucket.set(key, makeFromLocalhost(ld, transport));
    }
  }

  // Pass 3: BLE. We can only fuse on the 16-char install_id prefix,
  // so we look up existing buckets whose `installId` starts with
  // the BLE-advertised prefix. Anchorless BLE rows (no TLV 0x01)
  // get their own bucket keyed by the BLE address - we never fuse
  // them, see file header.
  for (const device of freshBleDevices) {
    const transport: RobotTransport = { type: 'ble', device };
    const matched = device.installIdPrefix
      ? findBucketByInstallIdPrefix(bucket, device.installIdPrefix)
      : null;
    if (matched) {
      mergeBleInto(matched, device, transport);
      continue;
    }
    const key = device.installIdPrefix
      ? installIdKey(device.installIdPrefix)
      : bleOnlyKey(device);
    bucket.set(key, makeFromBle(device, transport));
  }

  // Finalisation: sort transports per row, derive the rolled-up
  // health / display name, and emit the public shape.
  const robots = Array.from(bucket.values()).map(finalizeRobot);

  // Stable global ordering. See file header.
  robots.sort(compareRobots);

  return robots;
}

// ─── Mutable accumulator (internal only) ─────────────────────────────

interface MutableRobot {
  installId: string | null;
  key: string;
  /** First-source name candidates, picked in `finalizeRobot`. */
  centralName: string | null;
  localhostName: string | null;
  bleName: string | null;
  kind: RobotKind;
  wirelessVersion: boolean | null;
  health: RobotHealth;
  errorCode: string | null;
  visible: boolean;
  disabled: boolean;
  transports: RobotTransport[];
  lastSeenAt: number | null;
  rssi: number | null;
}

// ─── Source → MutableRobot constructors ──────────────────────────────

function makeFromCentral(
  entry: CentralRobotEntry,
  installId: string | null,
  policy: ReturnType<typeof centralEntryPolicy>,
  transport: RobotTransport,
): MutableRobot {
  // Use the typed central name when present; the generic "Unknown
  // robot" fallback from `extractRobotName` is treated here as
  // "no name", so a localhost / BLE name can take precedence.
  const rawName = entry.meta?.name ?? entry.robotName ?? entry.name ?? null;
  return {
    installId,
    key: installId ? installIdKey(installId) : centralOnlyKey(entry),
    centralName: typeof rawName === 'string' && rawName.length > 0 ? rawName : null,
    localhostName: null,
    bleName: null,
    kind: extractKind(entry),
    wirelessVersion: typeof entry.meta?.wireless_version === 'boolean'
      ? entry.meta.wireless_version
      : null,
    health: extractHealth(entry),
    errorCode: extractErrorCode(entry),
    visible: policy.visible,
    disabled: policy.disabled,
    transports: [transport],
    lastSeenAt: null,
    rssi: null,
  };
}

function makeFromLocalhost(
  daemon: LocalDaemonInfo,
  transport: RobotTransport,
): MutableRobot {
  return {
    installId: daemon.installId,
    key: daemon.installId
      ? installIdKey(daemon.installId)
      : localhostOnlyKey(daemon),
    centralName: null,
    localhostName: daemon.robotName ?? null,
    bleName: null,
    // Loopback ⇒ tray, by construction. See `localDaemonSource.ts`
    // file header for rationale.
    kind: LOCAL_DAEMON_KIND,
    wirelessVersion: LOCAL_DAEMON_WIRELESS,
    health: 'ok', // The probe succeeded ⇒ assume healthy. A future
    //              `/api/daemon/health` endpoint can refine this.
    errorCode: null,
    visible: true,
    disabled: false,
    transports: [transport],
    lastSeenAt: daemon.lastSeenAt,
    rssi: null,
  };
}

function makeFromBle(
  device: ReachyBleDevice,
  transport: RobotTransport,
): MutableRobot {
  return {
    // BLE only carries a 16-char prefix; we expose it as-is so the
    // matching with localhost/central full UUIDs is symmetric (they
    // accept comparing their own value's prefix).
    installId: device.installIdPrefix,
    key: device.installIdPrefix
      ? installIdKey(device.installIdPrefix)
      : bleOnlyKey(device),
    centralName: null,
    localhostName: null,
    bleName: device.name ?? null,
    // BLE-broadcast = robot (tray doesn't expose BLE).
    kind: 'robot',
    // BLE alone can't distinguish USB vs Wi-Fi (a USB-connected
    // robot also has BLE). Leave undecided until central confirms.
    wirelessVersion: null,
    health: 'unknown',
    errorCode: null,
    visible: true,
    disabled: false,
    transports: [transport],
    lastSeenAt: device.lastSeenMs ?? null,
    rssi: device.rssi,
  };
}

// ─── Source → existing-bucket merges ─────────────────────────────────

function mergeLocalhostInto(
  acc: MutableRobot,
  daemon: LocalDaemonInfo,
  transport: RobotTransport,
): void {
  acc.transports.push(transport);
  if (acc.localhostName === null) {
    acc.localhostName = daemon.robotName ?? null;
  }
  // Localhost can fill in a missing install_id when central did not
  // (legacy daemon producers); the full UUID always wins over any
  // truncated prefix we might have stored from a BLE-first pass.
  if (daemon.installId && fitsInstallIdPrefix(acc.installId, daemon.installId)) {
    acc.installId = daemon.installId;
  }
  // Liveness signal: prefer the freshest observation.
  if (daemon.lastSeenAt && (!acc.lastSeenAt || daemon.lastSeenAt > acc.lastSeenAt)) {
    acc.lastSeenAt = daemon.lastSeenAt;
  }
}

function mergeBleInto(
  acc: MutableRobot,
  device: ReachyBleDevice,
  transport: RobotTransport,
): void {
  acc.transports.push(transport);
  if (acc.bleName === null) {
    acc.bleName = device.name ?? null;
  }
  acc.rssi = device.rssi; // Always keep the latest RSSI.
  if (device.lastSeenMs && (!acc.lastSeenAt || device.lastSeenMs > acc.lastSeenAt)) {
    acc.lastSeenAt = device.lastSeenMs;
  }
}

// ─── Finalisation ────────────────────────────────────────────────────

function finalizeRobot(acc: MutableRobot): AggregatedRobot {
  acc.transports.sort(compareTransports);

  // Display name: pick the most authoritative source that named it.
  // central > localhost > ble. The default is reserved for fully
  // anonymous rows.
  const displayName =
    acc.centralName ?? acc.localhostName ?? acc.bleName ?? DEFAULT_DISPLAY_NAME;

  return {
    installId: acc.installId,
    key: acc.key,
    displayName,
    kind: acc.kind,
    wirelessVersion: acc.wirelessVersion,
    health: acc.health,
    errorCode: acc.errorCode,
    visible: acc.visible,
    disabled: acc.disabled,
    transports: acc.transports.slice(),
    lastSeenAt: acc.lastSeenAt,
    rssi: acc.rssi,
  };
}

// ─── Sort orders ─────────────────────────────────────────────────────

const TRANSPORT_RANK: Record<RobotTransport['type'], number> = {
  localhost: 0,
  ble: 1,
  central: 2,
};

function compareTransports(a: RobotTransport, b: RobotTransport): number {
  return TRANSPORT_RANK[a.type] - TRANSPORT_RANK[b.type];
}

function compareRobots(a: AggregatedRobot, b: AggregatedRobot): number {
  // Hidden rows last (consumers usually filter them, but a stable
  // ordering keeps debugging consistent).
  if (a.visible !== b.visible) return a.visible ? -1 : 1;
  if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
  const at = a.transports[0]?.type;
  const bt = b.transports[0]?.type;
  if (at && bt && at !== bt) return TRANSPORT_RANK[at] - TRANSPORT_RANK[bt];
  // Most-recently-seen first.
  const al = a.lastSeenAt ?? 0;
  const bl = b.lastSeenAt ?? 0;
  if (al !== bl) return bl - al;
  return a.displayName.localeCompare(b.displayName);
}

// ─── Key helpers ─────────────────────────────────────────────────────

function installIdKey(installIdOrPrefix: string): string {
  // Lowercase + truncate to the BLE prefix length so a BLE row and a
  // central row with the same identity collapse onto the same key
  // even though they expose different lengths of the same hex.
  return `iid:${installIdOrPrefix.toLowerCase().slice(0, BLE_INSTALL_ID_PREFIX_LEN)}`;
}
function centralOnlyKey(entry: CentralRobotEntry): string {
  return `central:${(entry.peerId ?? entry.id ?? entry.name ?? 'unknown').toString()}`;
}
function localhostOnlyKey(daemon: LocalDaemonInfo): string {
  return `localhost:${daemon.host}`;
}
function bleOnlyKey(device: ReachyBleDevice): string {
  return `ble:${device.address}`;
}

// ─── Match helpers ───────────────────────────────────────────────────

/**
 * Find an existing bucket whose `installId` shares the BLE-advertised
 * 16-char prefix. Returns the first match (there should never be
 * more than one - install_id collisions are caught by central, see
 * `_evict_install_id_collisions` server-side).
 */
function findBucketByInstallIdPrefix(
  bucket: Map<string, MutableRobot>,
  blePrefix: string,
): MutableRobot | null {
  const expectedKey = installIdKey(blePrefix);
  return bucket.get(expectedKey) ?? null;
}

/**
 * Predicate: would `incoming` be a valid promotion of `current`?
 *
 * Rules:
 *   - `current` null ⇒ always accept.
 *   - same value (case-insensitive) ⇒ accept (idempotent).
 *   - `incoming` extends `current` as a longer prefix ⇒ accept (we
 *     learned more about the same id, e.g. went from 16-char BLE
 *     prefix to a full 32-char central UUID).
 *   - otherwise ⇒ reject (mismatch, do not silently overwrite).
 */
function fitsInstallIdPrefix(
  current: string | null,
  incoming: string,
): boolean {
  if (!current) return true;
  const c = current.toLowerCase();
  const i = incoming.toLowerCase();
  if (c === i) return true;
  return i.startsWith(c);
}
