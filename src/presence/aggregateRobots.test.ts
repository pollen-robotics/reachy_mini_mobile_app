/**
 * Unit tests for `aggregateRobots` and `pickBestTarget`.
 *
 * Coverage map - keep in sync as cases are added:
 *   - empty input
 *   - single source: BLE only / central only / localhost only
 *   - fusion by full install_id (localhost + central)
 *   - fusion by install_id prefix (BLE + central)
 *   - anchorless fusion is forbidden
 *   - the bug from 2026-04-29: BLE robot ≠ tray, central lists only
 *     the tray. Aggregator must NOT fuse them.
 *   - foreign BLE neighbour with my central robot: 2 distinct
 *     entries, never confused.
 *   - install_id case-insensitive matching.
 *   - tray + error ⇒ hidden via centralEntryPolicy.
 *   - sort order: localhost > ble > central, recency tiebreak.
 *   - pickBestTarget: priority order + `prefer` override.
 *   - pickBestTarget: refuses on disabled / empty.
 *   - 2026-04-29 stale-central regression: BLE TLV
 *     `networkMode='hotspot'|'offline'` shadows the central entry.
 *   - BLE staleness pruning: devices last seen > BLE_STALE_AGE_MS
 *     ago are dropped from the aggregated output.
 */
import { describe, it, expect } from 'vitest';

import type { CentralRobotEntry } from '../auth/fetchRobotsFromCentral';
import type { ReachyBleDevice } from '../ble/useBleSession';

import { aggregateRobots } from './aggregateRobots';
import type { LocalDaemonInfo } from './localDaemonSource';

// ─── Builders ────────────────────────────────────────────────────────

/**
 * Default `ble()` rows are stamped at "right now" so they survive the
 * aggregator's `BLE_STALE_AGE_MS` cutoff (60 s). Tests that exercise
 * recency or staleness pass explicit `lastSeenMs` and `nowMs` to make
 * the relationship deterministic.
 */
function ble(overrides: Partial<ReachyBleDevice> = {}): ReachyBleDevice {
  return {
    address: 'BLE-AAA',
    name: 'reachy-mini',
    rssi: -50,
    lastSeenMs: Date.now(),
    installIdPrefix: null,
    centralPeerIdPrefix: null,
    networkMode: null,
    ...overrides,
  };
}

function central(
  overrides: Partial<CentralRobotEntry> = {},
  meta: Partial<NonNullable<CentralRobotEntry['meta']>> = {},
): CentralRobotEntry {
  return {
    id: overrides.id ?? overrides.peerId ?? 'central-peer-id',
    peerId: overrides.peerId ?? 'central-peer-id',
    name: 'reachy_mini',
    robotName: undefined,
    ...overrides,
    meta: {
      name: 'reachy_mini',
      ...meta,
    },
  } as CentralRobotEntry;
}

function localDaemon(
  overrides: Partial<LocalDaemonInfo> = {},
): LocalDaemonInfo {
  return {
    host: '127.0.0.1',
    installId: '993bc9' + 'a'.repeat(26),
    centralPeerId: 'tray-peer-id',
    robotName: 'reachy_mini',
    robotNameSource: 'persisted',
    apiRevision: '3',
    daemonVersion: '1.7.0',
    lastSeenAt: 2_000,
    ...overrides,
  };
}

const FULL_INSTALL_ID_A = '639d55' + '0'.repeat(26); // BLE robot
const FULL_INSTALL_ID_B = '993bc9' + 'a'.repeat(26); // tray
const FULL_INSTALL_ID_C = 'feedfa' + 'c'.repeat(26); // foreign neighbour

const PREFIX_A = FULL_INSTALL_ID_A.slice(0, 16);
const PREFIX_B = FULL_INSTALL_ID_B.slice(0, 16);

// ─── Empty / single-source cases ─────────────────────────────────────

describe('aggregateRobots - empty / single source', () => {
  it('returns [] on empty input', () => {
    const out = aggregateRobots({
      bleDevices: [],
      centralRobots: [],
      localDaemon: null,
    });
    expect(out).toEqual([]);
  });

  it('emits a single BLE-only robot', () => {
    const device = ble({ installIdPrefix: PREFIX_A });
    const out = aggregateRobots({
      bleDevices: [device],
      centralRobots: [],
      localDaemon: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].installId).toBe(PREFIX_A);
    expect(out[0].transports).toHaveLength(1);
    expect(out[0].transports[0].type).toBe('ble');
    expect(out[0].kind).toBe('robot');
    expect(out[0].wirelessVersion).toBeNull();
  });

  it('emits a single central-only robot', () => {
    const entry = central({ peerId: 'p1' }, {
      install_id: FULL_INSTALL_ID_B,
      kind: 'robot',
      wireless_version: true,
      health: 'ok',
    });
    const out = aggregateRobots({
      bleDevices: [],
      centralRobots: [entry],
      localDaemon: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].installId).toBe(FULL_INSTALL_ID_B);
    expect(out[0].kind).toBe('robot');
    expect(out[0].wirelessVersion).toBe(true);
    expect(out[0].health).toBe('ok');
  });

  it('emits a single localhost-only entry as a tray with USB defaults', () => {
    const out = aggregateRobots({
      bleDevices: [],
      centralRobots: [],
      localDaemon: localDaemon(),
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('tray');
    expect(out[0].wirelessVersion).toBe(false);
    expect(out[0].transports[0].type).toBe('localhost');
  });
});

// ─── Fusion: localhost + central ─────────────────────────────────────

describe('aggregateRobots - localhost + central fusion', () => {
  it('fuses on full install_id', () => {
    const tray = localDaemon({ installId: FULL_INSTALL_ID_B });
    const entry = central({ peerId: 'central-tray' }, {
      install_id: FULL_INSTALL_ID_B,
      kind: 'tray',
    });
    const out = aggregateRobots({
      bleDevices: [],
      centralRobots: [entry],
      localDaemon: tray,
    });
    expect(out).toHaveLength(1);
    expect(out[0].transports.map((t) => t.type)).toEqual([
      'localhost',
      'central',
    ]);
    expect(out[0].installId).toBe(FULL_INSTALL_ID_B);
    expect(out[0].kind).toBe('tray');
  });

  it('keeps localhost separate when central reports a different install_id', () => {
    const tray = localDaemon({ installId: FULL_INSTALL_ID_B });
    const entry = central({ peerId: 'central-other' }, {
      install_id: FULL_INSTALL_ID_C,
      kind: 'robot',
    });
    const out = aggregateRobots({
      bleDevices: [],
      centralRobots: [entry],
      localDaemon: tray,
    });
    expect(out).toHaveLength(2);
  });
});

// ─── Fusion: BLE + central via prefix ────────────────────────────────

describe('aggregateRobots - BLE + central fusion', () => {
  it('fuses on install_id prefix', () => {
    const device = ble({ installIdPrefix: PREFIX_A });
    const entry = central({ peerId: 'central-A' }, {
      install_id: FULL_INSTALL_ID_A,
      kind: 'robot',
      wireless_version: true,
      health: 'ok',
    });
    const out = aggregateRobots({
      bleDevices: [device],
      centralRobots: [entry],
      localDaemon: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].transports.map((t) => t.type)).toEqual(['ble', 'central']);
    // BLE-only would have left the prefix; the merge promotes it to
    // the full UUID once central confirmed.
    expect(out[0].installId).toBe(FULL_INSTALL_ID_A);
    // Central is authoritative for kind / wireless / health, BLE just
    // contributed proximity + name.
    expect(out[0].kind).toBe('robot');
    expect(out[0].wirelessVersion).toBe(true);
    expect(out[0].health).toBe('ok');
  });

  it('matches case-insensitively', () => {
    const device = ble({ installIdPrefix: PREFIX_A.toUpperCase() });
    const entry = central({ peerId: 'central-A' }, {
      install_id: FULL_INSTALL_ID_A.toLowerCase(),
    });
    const out = aggregateRobots({
      bleDevices: [device],
      centralRobots: [entry],
      localDaemon: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].transports.map((t) => t.type)).toEqual(['ble', 'central']);
  });
});

// ─── The 2026-04-29 bug ─────────────────────────────────────────────

describe('aggregateRobots - regression: BLE robot ≠ tray, central lists only the tray', () => {
  it('keeps BLE robot and tray as 2 distinct entries', () => {
    // What the user actually saw on screen:
    //   - BLE: install_id #639d55... (the real Reachy)
    //   - localhost tray: install_id #993bc9...
    //   - central: only the tray (#993bc9), NOT the BLE robot
    // The old resolver would pick `robots[0]` (the tray) when the
    // BLE flow asked it for a peer id, hijacking the connection.
    // The aggregator must guarantee these stay separate.
    const bleRobot = ble({
      address: 'BLE-real',
      name: 'reachy-mini',
      installIdPrefix: PREFIX_A,
    });
    const tray = localDaemon({ installId: FULL_INSTALL_ID_B });
    const trayOnCentral = central({ peerId: 'tray-peer' }, {
      install_id: FULL_INSTALL_ID_B,
      kind: 'tray',
    });
    const out = aggregateRobots({
      bleDevices: [bleRobot],
      centralRobots: [trayOnCentral],
      localDaemon: tray,
    });
    expect(out).toHaveLength(2);
    const byKind = Object.fromEntries(
      out.map((r) => [r.kind, r] as const),
    );
    // BLE robot stays a BLE-only entry.
    expect(byKind.robot.installId).toBe(PREFIX_A);
    expect(byKind.robot.transports.map((t) => t.type)).toEqual(['ble']);
    // The tray fuses localhost + central (same install_id).
    expect(byKind.tray.installId).toBe(FULL_INSTALL_ID_B);
    expect(byKind.tray.transports.map((t) => t.type)).toEqual([
      'localhost',
      'central',
    ]);
  });

  it('foreign-fleet variant: my BLE robot, my central robot is unrelated', () => {
    const bleNeighbour = ble({
      address: 'BLE-neighbour',
      name: 'colleague-reachy',
      installIdPrefix: PREFIX_A,
    });
    const myCentralRobot = central({ peerId: 'mine' }, {
      install_id: FULL_INSTALL_ID_C,
      kind: 'robot',
      wireless_version: true,
    });
    const out = aggregateRobots({
      bleDevices: [bleNeighbour],
      centralRobots: [myCentralRobot],
      localDaemon: null,
    });
    expect(out).toHaveLength(2);
    expect(
      out.find((r) => r.transports.some((t) => t.type === 'ble'))?.installId,
    ).toBe(PREFIX_A);
    expect(
      out.find((r) => r.transports.every((t) => t.type === 'central'))
        ?.installId,
    ).toBe(FULL_INSTALL_ID_C);
  });
});

// ─── Anchorless rows are never fused ────────────────────────────────

describe('aggregateRobots - anchorless rows', () => {
  it('does not fuse two BLE rows that have no install_id', () => {
    const a = ble({ address: 'BLE-A', name: 'reachy_mini' });
    const b = ble({ address: 'BLE-B', name: 'reachy_mini' });
    const out = aggregateRobots({
      bleDevices: [a, b],
      centralRobots: [],
      localDaemon: null,
    });
    expect(out).toHaveLength(2);
  });

  it('does not fuse anchorless central + anchorless BLE', () => {
    const device = ble({ name: 'reachy_mini' });
    const entry = central({ peerId: 'p1', name: 'reachy_mini' });
    const out = aggregateRobots({
      bleDevices: [device],
      centralRobots: [entry],
      localDaemon: null,
    });
    expect(out).toHaveLength(2);
  });
});

// ─── Policy: tray-error is hidden ───────────────────────────────────

describe('aggregateRobots - policy', () => {
  it('hides tray entries in error state', () => {
    const entry = central({ peerId: 'tray-error' }, {
      install_id: FULL_INSTALL_ID_B,
      kind: 'tray',
      health: 'error',
      error_code: 'no_backend',
    });
    const out = aggregateRobots({
      bleDevices: [],
      centralRobots: [entry],
      localDaemon: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].visible).toBe(false);
  });

  it('keeps robot-error rows visible but disabled', () => {
    const entry = central({ peerId: 'robot-error' }, {
      install_id: FULL_INSTALL_ID_A,
      kind: 'robot',
      health: 'error',
      error_code: 'backend_not_ready',
    });
    const out = aggregateRobots({
      bleDevices: [],
      centralRobots: [entry],
      localDaemon: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].visible).toBe(true);
    expect(out[0].disabled).toBe(true);
    expect(out[0].errorCode).toBe('backend_not_ready');
  });
});

// ─── Sort order ─────────────────────────────────────────────────────

describe('aggregateRobots - sort order', () => {
  it('puts localhost > ble > central as the best transport tier', () => {
    // All timestamps frozen relative to a fixed `now` so the
    // BLE_STALE_AGE_MS guard never kicks in.
    const NOW = 100_000;
    const out = aggregateRobots({
      bleDevices: [ble({ installIdPrefix: PREFIX_A, lastSeenMs: NOW - 5_000 })],
      centralRobots: [
        central({ peerId: 'lonely-central' }, { install_id: FULL_INSTALL_ID_C }),
      ],
      localDaemon: localDaemon({ installId: FULL_INSTALL_ID_B }),
      nowMs: NOW,
    });
    expect(out.map((r) => r.transports[0].type)).toEqual([
      'localhost',
      'ble',
      'central',
    ]);
  });

  it('falls back to recency within the same transport tier', () => {
    const NOW = 100_000;
    const out = aggregateRobots({
      bleDevices: [
        ble({
          address: 'BLE-old',
          installIdPrefix: PREFIX_A,
          lastSeenMs: NOW - 9_000,
        }),
        ble({
          address: 'BLE-new',
          installIdPrefix: PREFIX_B,
          lastSeenMs: NOW - 1_000,
        }),
      ],
      centralRobots: [],
      localDaemon: null,
      nowMs: NOW,
    });
    expect(out.map((r) => r.installId)).toEqual([PREFIX_B, PREFIX_A]);
  });
});

// ─── Stale-central shadow (2026-04-29 regression) ───────────────────
//
// Scenario: user just executed `WIFI_FORGET` on a wireless robot.
// The daemon called `notify_withdraw` (best-effort, may have failed
// since the wlan was about to die anyway), then dropped Wi-Fi.
// Within 10 s the BLE advert flips to networkMode='hotspot'. The
// HF central listing still carries the entry until the lease (~45 s)
// or the next mobile poll (60 s in stable steady state).
//
// Expected behaviour: the aggregator MUST treat the BLE TLV as
// authoritative and drop the stale central transport. The UI then
// renders `Bluetooth + Setup pending` instead of `Wi-Fi + Central`,
// and `pickBestTarget` returns the BLE transport so the next tap
// goes to `WifiSetupScreen` directly.

describe('aggregateRobots - stale central shadowed by BLE networkMode', () => {
  const wirelessCentral = central({ peerId: 'central-A' }, {
    install_id: FULL_INSTALL_ID_A,
    kind: 'robot',
    wireless_version: true,
    health: 'ok',
  });

  it("drops the central transport when BLE TLV says 'hotspot'", () => {
    const device = ble({
      installIdPrefix: PREFIX_A,
      networkMode: 'hotspot',
    });
    const out = aggregateRobots({
      bleDevices: [device],
      centralRobots: [wirelessCentral],
      localDaemon: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].transports.map((t) => t.type)).toEqual(['ble']);
    // Central-derived metadata is also gone (we never built a bucket
    // from the central entry), so chip computation falls through to
    // the BLE-only branch where `wirelessVersion === null`.
    expect(out[0].wirelessVersion).toBeNull();
    expect(out[0].health).toBe('unknown');
  });

  it("drops the central transport when BLE TLV says 'offline'", () => {
    const device = ble({
      installIdPrefix: PREFIX_A,
      networkMode: 'offline',
    });
    const out = aggregateRobots({
      bleDevices: [device],
      centralRobots: [wirelessCentral],
      localDaemon: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].transports.map((t) => t.type)).toEqual(['ble']);
  });

  it("KEEPS the central transport when BLE TLV says 'connected'", () => {
    const device = ble({
      installIdPrefix: PREFIX_A,
      networkMode: 'connected',
    });
    const out = aggregateRobots({
      bleDevices: [device],
      centralRobots: [wirelessCentral],
      localDaemon: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].transports.map((t) => t.type)).toEqual(['ble', 'central']);
  });

  it('KEEPS the central transport when BLE TLV is absent (legacy daemon)', () => {
    // Legacy advertiser without TLV 0x03 surfaces `networkMode: null`.
    // We must NOT trust BLE silence as proof of an offline state -
    // the user would lose the central path on every legacy robot.
    const device = ble({
      installIdPrefix: PREFIX_A,
      networkMode: null,
    });
    const out = aggregateRobots({
      bleDevices: [device],
      centralRobots: [wirelessCentral],
      localDaemon: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].transports.map((t) => t.type)).toEqual(['ble', 'central']);
  });

  it('only shadows the central entry that matches the offline BLE prefix', () => {
    // Two robots: A is offline (BLE says hotspot), B is connected.
    // The shadow rule must be per-install_id, not global.
    const offlineDevice = ble({
      address: 'BLE-A',
      installIdPrefix: PREFIX_A,
      networkMode: 'offline',
    });
    const onlineDevice = ble({
      address: 'BLE-B',
      installIdPrefix: PREFIX_B,
      networkMode: 'connected',
    });
    const centralA = central({ peerId: 'central-A' }, {
      install_id: FULL_INSTALL_ID_A,
      kind: 'robot',
      wireless_version: true,
    });
    const centralB = central({ peerId: 'central-B' }, {
      install_id: FULL_INSTALL_ID_B,
      kind: 'robot',
      wireless_version: true,
    });
    const out = aggregateRobots({
      bleDevices: [offlineDevice, onlineDevice],
      centralRobots: [centralA, centralB],
      localDaemon: null,
    });
    const robotA = out.find(
      (r) => r.installId?.slice(0, 16) === PREFIX_A,
    );
    const robotB = out.find(
      (r) => r.installId?.slice(0, 16) === PREFIX_B,
    );
    // A: BLE-only (central shadowed).
    expect(robotA?.transports.map((t) => t.type)).toEqual(['ble']);
    // B: BLE + central (TLV says connected, no shadow).
    expect(robotB?.transports.map((t) => t.type)).toEqual(['ble', 'central']);
  });

  it('does NOT shadow central entries whose install_id is unknown to BLE', () => {
    // An offline BLE neighbour we don't own AND a different central
    // entry: no shared install_id, no shadow.
    const offlineDevice = ble({
      installIdPrefix: PREFIX_A,
      networkMode: 'hotspot',
    });
    const myCentral = central({ peerId: 'mine' }, {
      install_id: FULL_INSTALL_ID_C,
      kind: 'robot',
      wireless_version: true,
    });
    const out = aggregateRobots({
      bleDevices: [offlineDevice],
      centralRobots: [myCentral],
      localDaemon: null,
    });
    expect(out).toHaveLength(2);
    expect(
      out.find((r) => r.installId === FULL_INSTALL_ID_C)?.transports.map(
        (t) => t.type,
      ),
    ).toEqual(['central']);
  });

  it("ignores BLE TLV if the BLE advert has no install_id prefix", () => {
    // Anchorless BLE row carrying a networkMode: we cannot match
    // it to any central entry without a prefix, so the central
    // listing must remain intact.
    const device = ble({
      installIdPrefix: null,
      networkMode: 'hotspot',
    });
    const out = aggregateRobots({
      bleDevices: [device],
      centralRobots: [wirelessCentral],
      localDaemon: null,
    });
    expect(out).toHaveLength(2); // BLE-only + central-only kept apart
    const central_only = out.find(
      (r) => r.installId === FULL_INSTALL_ID_A,
    );
    expect(central_only?.transports.map((t) => t.type)).toEqual(['central']);
  });

  it('drops central but keeps localhost when USB is up and BLE says offline', () => {
    // Edge case: the robot is plugged in via USB to this Mac (so
    // localhost is reachable) AND its Wi-Fi was just reset. Central
    // is stale, BLE says hotspot. We should keep localhost+ble and
    // drop only central.
    const device = ble({
      installIdPrefix: PREFIX_B,
      networkMode: 'hotspot',
    });
    const tray = localDaemon({ installId: FULL_INSTALL_ID_B });
    const staleCentral = central({ peerId: 'tray-central' }, {
      install_id: FULL_INSTALL_ID_B,
      kind: 'tray',
    });
    const out = aggregateRobots({
      bleDevices: [device],
      centralRobots: [staleCentral],
      localDaemon: tray,
    });
    expect(out).toHaveLength(1);
    expect(out[0].transports.map((t) => t.type)).toEqual([
      'localhost',
      'ble',
    ]);
  });

  it('matches case-insensitively when shadowing', () => {
    const device = ble({
      installIdPrefix: PREFIX_A.toUpperCase(),
      networkMode: 'hotspot',
    });
    const entry = central({ peerId: 'central-A' }, {
      install_id: FULL_INSTALL_ID_A.toLowerCase(),
      kind: 'robot',
      wireless_version: true,
    });
    const out = aggregateRobots({
      bleDevices: [device],
      centralRobots: [entry],
      localDaemon: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].transports.map((t) => t.type)).toEqual(['ble']);
  });
});

// ─── BLE staleness pruning ──────────────────────────────────────────
//
// The scanner is invoked with `{ preserve: true }` every ~14 s, so
// the BLE store accumulates every device it ever saw. Without an
// age cutoff in the aggregator, a robot that was visible once and
// is now off would stick around forever with its last-known advert,
// confusing the user with rows that fail every tap. The aggregator
// owns this filter so the underlying store is unchanged (debug
// observability, recovery on re-broadcast).

describe('aggregateRobots - stale BLE pruning', () => {
  it('drops a BLE device whose last-seen exceeds BLE_STALE_AGE_MS', () => {
    const fresh = ble({
      address: 'BLE-fresh',
      installIdPrefix: PREFIX_A,
      lastSeenMs: 100_000,
    });
    const ancient = ble({
      address: 'BLE-fossil',
      installIdPrefix: PREFIX_B,
      lastSeenMs: 1_000, // 99 s old at nowMs=100_000
    });
    const out = aggregateRobots({
      bleDevices: [fresh, ancient],
      centralRobots: [],
      localDaemon: null,
      nowMs: 100_000,
    });
    expect(out).toHaveLength(1);
    expect(out[0].installId).toBe(PREFIX_A);
  });

  it('keeps a BLE device exactly at the threshold', () => {
    const onTheEdge = ble({
      installIdPrefix: PREFIX_A,
      lastSeenMs: 40_000, // 60 s old at nowMs=100_000 (threshold)
    });
    const out = aggregateRobots({
      bleDevices: [onTheEdge],
      centralRobots: [],
      localDaemon: null,
      nowMs: 100_000,
    });
    expect(out).toHaveLength(1);
  });

  it('keeps devices with no lastSeenMs (defensive: unknown freshness)', () => {
    const noTimestamp = ble({
      installIdPrefix: PREFIX_A,
      lastSeenMs: 0,
    });
    const out = aggregateRobots({
      bleDevices: [noTimestamp],
      centralRobots: [],
      localDaemon: null,
      nowMs: 100_000,
    });
    expect(out).toHaveLength(1);
  });

  it('drops a stale BLE device but keeps its central counterpart visible', () => {
    // Robot was seen briefly, walked away, central still lists it.
    // We want the central row to remain so the user can still try
    // the WebRTC path; only the BLE proximity signal is lost.
    const ancientBle = ble({
      installIdPrefix: PREFIX_A,
      lastSeenMs: 1_000,
    });
    const stillOnCentral = central({ peerId: 'central-A' }, {
      install_id: FULL_INSTALL_ID_A,
      kind: 'robot',
      wireless_version: true,
    });
    const out = aggregateRobots({
      bleDevices: [ancientBle],
      centralRobots: [stillOnCentral],
      localDaemon: null,
      nowMs: 100_000,
    });
    expect(out).toHaveLength(1);
    expect(out[0].transports.map((t) => t.type)).toEqual(['central']);
  });

  it('a stale BLE device with hotspot TLV does NOT shadow central anymore', () => {
    // Symmetric guard: stale BLE evidence shouldn't be trusted as
    // proof that central is wrong. Only fresh BLE TLVs override
    // central. Otherwise an old BLE snapshot from before the user
    // ran Wi-Fi setup would incorrectly hide the now-online robot.
    const staleOfflineBle = ble({
      installIdPrefix: PREFIX_A,
      networkMode: 'hotspot',
      lastSeenMs: 1_000, // ancient
    });
    const liveCentral = central({ peerId: 'central-A' }, {
      install_id: FULL_INSTALL_ID_A,
      kind: 'robot',
      wireless_version: true,
    });
    const out = aggregateRobots({
      bleDevices: [staleOfflineBle],
      centralRobots: [liveCentral],
      localDaemon: null,
      nowMs: 100_000,
    });
    expect(out).toHaveLength(1);
    expect(out[0].transports.map((t) => t.type)).toEqual(['central']);
  });

  it('uses Date.now() as default when nowMs is unset (smoke test)', () => {
    // Sanity: a device with `lastSeenMs` close to "now" must not be
    // pruned when the caller does not pass `nowMs`.
    const fresh = ble({
      installIdPrefix: PREFIX_A,
      lastSeenMs: Date.now(),
    });
    const out = aggregateRobots({
      bleDevices: [fresh],
      centralRobots: [],
      localDaemon: null,
    });
    expect(out).toHaveLength(1);
  });
});
