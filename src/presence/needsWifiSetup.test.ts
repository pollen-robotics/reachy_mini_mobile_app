/**
 * Unit tests for `needsWifiSetup`.
 *
 * The helper drives a routing-critical short-circuit: when it returns
 * `true`, the user is sent straight to `WifiSetupScreen` instead of
 * RobotSessionScreen. False positives strand a perfectly-fine robot
 * in setup; false negatives produce a "Set up Wi-Fi?" failure flash
 * before the user gets there. Both are bad UX, hence the dedicated
 * coverage.
 */
import { describe, expect, it } from 'vitest';

import type { CentralRobotEntry } from '../auth/fetchRobotsFromCentral';
import type { ReachyBleDevice } from '../ble/useBleSession';

import type { AggregatedRobot, RobotTransport } from './aggregatedRobot';
import { needsWifiSetup } from './needsWifiSetup';
import type { LocalDaemonInfo } from './localDaemonSource';

function ble(
  overrides: Partial<ReachyBleDevice> = {},
): Extract<RobotTransport, { type: 'ble' }> {
  return {
    type: 'ble',
    device: {
      address: 'BLE-AAA',
      name: 'reachy-mini',
      rssi: -50,
      lastSeenMs: 1_000,
      installIdPrefix: null,
      centralPeerIdPrefix: null,
      networkMode: null,
      ...overrides,
    },
  };
}

function central(): Extract<RobotTransport, { type: 'central' }> {
  return {
    type: 'central',
    entry: {
      id: 'p',
      peerId: 'p',
      name: 'reachy_mini',
      kind: 'robot',
      meta: { install_id: 'a'.repeat(32) },
    } as unknown as CentralRobotEntry,
  };
}

function localhost(): Extract<RobotTransport, { type: 'localhost' }> {
  return {
    type: 'localhost',
    daemon: {
      host: '127.0.0.1',
      port: 8000,
      installId: 'b'.repeat(32),
      robotName: 'tray',
      apiRev: 3,
    } as unknown as LocalDaemonInfo,
  };
}

function robot(transports: RobotTransport[]): AggregatedRobot {
  return {
    installId: null,
    key: 'k',
    displayName: 'r',
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

describe('needsWifiSetup', () => {
  it('returns true when BLE network_mode is hotspot', () => {
    expect(needsWifiSetup(robot([ble({ networkMode: 'hotspot' })]))).toBe(true);
  });

  it('returns true when BLE network_mode is offline', () => {
    expect(needsWifiSetup(robot([ble({ networkMode: 'offline' })]))).toBe(true);
  });

  it('returns false when BLE network_mode is connected', () => {
    expect(needsWifiSetup(robot([ble({ networkMode: 'connected' })]))).toBe(false);
  });

  it('returns false when BLE network_mode is null (legacy daemon)', () => {
    // Legacy daemons don't publish the TLV. We deliberately do NOT
    // route to setup here; the regular handshake path will surface
    // the "Set up Wi-Fi?" affordance via HandshakeFailureView if it
    // turns out the robot is in hotspot, so we lose nothing.
    expect(needsWifiSetup(robot([ble({ networkMode: null })]))).toBe(false);
  });

  it('returns false when no BLE transport is present', () => {
    // A central-only or localhost-only robot has no BLE link to its
    // hotspot, so even if it were offline we have no path to provision
    // Wi-Fi. Sending the user to setup would strand them.
    expect(needsWifiSetup(robot([central()]))).toBe(false);
    expect(needsWifiSetup(robot([localhost()]))).toBe(false);
    expect(needsWifiSetup(robot([central(), localhost()]))).toBe(false);
  });

  it('uses the BLE transport even when other transports coexist', () => {
    // Hybrid: robot is on central AND visible via BLE in hotspot
    // mode. Counter-intuitive but real: BLE advert is updated by
    // bluetooth_service.py independently, and could lag behind a
    // recent Wi-Fi join (or document a Wi-Fi loss). Trust the BLE
    // signal: that's what the user sees on the card.
    const r = robot([central(), ble({ networkMode: 'hotspot' })]);
    expect(needsWifiSetup(r)).toBe(true);
  });

  it('returns false on an empty transport list (defensive)', () => {
    expect(needsWifiSetup(robot([]))).toBe(false);
  });
});
