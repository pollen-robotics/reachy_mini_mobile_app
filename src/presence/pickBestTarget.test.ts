/**
 * Unit tests for `pickBestTarget`.
 *
 * Verifies the priority order and the override behavior of `prefer`,
 * which together encode the policy that prevents the
 * "wrong robot via wrong transport" bug from re-emerging.
 */
import { describe, it, expect } from 'vitest';

import type {
  AggregatedRobot,
  RobotTransport,
} from './aggregatedRobot';
import { pickBestTarget, listTransports } from './pickBestTarget';

const FULL_INSTALL_ID = 'a'.repeat(32);

function robot(transports: RobotTransport[]): AggregatedRobot {
  return {
    installId: FULL_INSTALL_ID,
    key: `iid:${FULL_INSTALL_ID.slice(0, 16)}`,
    displayName: 'Reachy de Test',
    kind: 'robot',
    wirelessVersion: null,
    health: 'ok',
    errorCode: null,
    visible: true,
    disabled: false,
    transports,
    lastSeenAt: 1_000,
    rssi: null,
  };
}

const localhostT: RobotTransport = {
  type: 'localhost',
  daemon: {
    host: '127.0.0.1',
    installId: FULL_INSTALL_ID,
    centralPeerId: null,
    robotName: 'reachy_mini',
    robotNameSource: 'persisted',
    apiRevision: '3',
    daemonVersion: '1.7.0',
    lastSeenAt: 1_000,
  },
};

const bleT: RobotTransport = {
  type: 'ble',
  device: {
    address: 'BLE-AAA',
    name: 'reachy-mini',
    rssi: -50,
    lastSeenMs: 1_000,
    installIdPrefix: FULL_INSTALL_ID.slice(0, 16),
    centralPeerIdPrefix: null,
    networkMode: null,
  },
};

type CentralTransport = Extract<RobotTransport, { type: 'central' }>;

const centralT: RobotTransport = {
  type: 'central',
  // The shape only matters at the call site, we exercise the mapping
  // and not the contents of `entry` here.
  entry: { id: 'c1', peerId: 'c1' } as CentralTransport['entry'],
};

describe('pickBestTarget - priority', () => {
  it('returns null when transports is empty', () => {
    expect(pickBestTarget(robot([]))).toBeNull();
  });

  it('returns null when the robot is disabled', () => {
    expect(pickBestTarget({ ...robot([centralT]), disabled: true })).toBeNull();
  });

  it('prefers localhost over ble over central', () => {
    const target = pickBestTarget(robot([localhostT, bleT, centralT]));
    expect(target?.kind).toBe('localhost');
  });

  it('falls through to ble when no localhost is available', () => {
    const target = pickBestTarget(robot([bleT, centralT]));
    expect(target?.kind).toBe('local'); // ble → local on the FSM side
  });

  it('falls through to central when no closer transport is available', () => {
    const target = pickBestTarget(robot([centralT]));
    expect(target?.kind).toBe('remote');
  });
});

describe('pickBestTarget - prefer override', () => {
  it('honours an explicit transport pin', () => {
    const target = pickBestTarget(robot([localhostT, bleT, centralT]), {
      prefer: 'ble',
    });
    expect(target?.kind).toBe('local');
  });

  it('returns null when the preferred transport is not available', () => {
    const target = pickBestTarget(robot([centralT]), { prefer: 'ble' });
    expect(target).toBeNull();
  });
});

describe('pickBestTarget - mapping', () => {
  it('localhost transport produces a {kind: localhost} target with the daemon fields wired through', () => {
    const target = pickBestTarget(robot([localhostT]));
    if (target?.kind !== 'localhost') throw new Error('wrong kind');
    expect(target.host).toBe('127.0.0.1');
    expect(target.installId).toBe(FULL_INSTALL_ID);
    expect(target.robotName).toBe('reachy_mini');
  });

  it('ble transport produces a {kind: local} target carrying the BLE device handle', () => {
    const target = pickBestTarget(robot([bleT]));
    if (target?.kind !== 'local') throw new Error('wrong kind');
    expect(target.device.address).toBe('BLE-AAA');
  });

  it('central transport produces a {kind: remote} target carrying the entry', () => {
    const target = pickBestTarget(robot([centralT]));
    if (target?.kind !== 'remote') throw new Error('wrong kind');
    expect(target.robot.peerId).toBe('c1');
  });
});

describe('listTransports', () => {
  it('returns the transport types in their stored order', () => {
    expect(listTransports(robot([localhostT, bleT, centralT]))).toEqual([
      'localhost',
      'ble',
      'central',
    ]);
  });
});
