/**
 * Direct phone → wheeled base link over Bluetooth Classic serial (SPP),
 * without Reachy Mini. Native side: `src-tauri/plugins/tauri-plugin-spp`.
 *
 * Speaks the firmware's line protocol exactly like the daemon's
 * `HoverboardManager` does on its own link (feat/hoverboard, protocol.py):
 *
 *   stand up   S0
 *   sit        T0 R0 S1 Z1        (controlled sit-down, wheels on the ground)
 *   STOP       E1 T0 R0 S1 Z1     (E1 = instant motor cut, bench firmware)
 *   drive      T<throttle> R<turn>, -100..100
 *
 * and reads the bench firmware's 2 Hz status line
 * (`[diag] state=Balancing ... angle_deg=1.2 ... vbat=12.01 ...`) and its
 * `ok <line>` acks. The stock firmware is silent: the link still drives,
 * the status just stays unknown.
 *
 * Signs: the app's drive is forward / left positive. Rémi's prototype
 * needs both flipped on the wire (the daemon's invert_throttle=True and
 * FIRMWARE_TURN_SIGN=-1), so do we.
 *
 * Safety: the firmware has no link deadman and keeps the last T/R if the
 * link drops. The app zeroes the drive whenever it stops driving (release,
 * app backgrounded, screen left), but a radio loss mid-drive can't be
 * caught from here.
 */
import { Channel, invoke } from '@tauri-apps/api/core';

import type { HoverboardFirmwareState } from './hoverboard';
import type { OverboardDrive } from './types';

export const THROTTLE_WIRE_SIGN = -1;
export const TURN_WIRE_SIGN = -1;

/** Bluetooth name the base advertises. */
export const BASE_DEVICE_NAME = 'rmini_wheels';

export interface BondedDevice {
  name: string;
  address: string;
}

export interface DirectTelemetry {
  state: HoverboardFirmwareState | string;
  tiltDeg: number;
  batteryV: number | null;
  /** Date.now() of the status line. */
  at: number;
}

type PluginEvent = { type: 'line'; line: string } | { type: 'disconnected'; reason: string };

export function encodeDrive(drive: OverboardDrive): string {
  const pct = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 100) || 0;
  return `T${pct(drive.linear) * THROTTLE_WIRE_SIGN || 0}\nR${pct(drive.angular) * TURN_WIRE_SIGN || 0}\n`;
}

export const WIRE = {
  standUp: 'S0\n',
  sit: 'T0\nR0\nS1\nZ1\n',
  stop: 'E1\nT0\nR0\nS1\nZ1\n',
  zero: 'T0\nR0\n',
} as const;

/** Parse one bench-firmware status line; null for anything else. */
export function parseStatusLine(line: string, now = Date.now()): DirectTelemetry | null {
  const m = /^\[diag\] state=(\w+)/.exec(line);
  if (!m) return null;
  const values: Record<string, number> = {};
  for (const token of line.split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const v = Number(token.slice(eq + 1));
    if (Number.isFinite(v)) values[token.slice(0, eq)] = v;
  }
  return {
    state: m[1],
    tiltDeg: values.angle_deg ?? 0,
    batteryV: values.vbat ?? null,
    at: now,
  };
}

/** Thin wrapper over the native plugin; one link at a time. */
export const sppNative = {
  bonded: async (): Promise<BondedDevice[]> =>
    (await invoke<{ devices: BondedDevice[] }>('plugin:spp|bonded')).devices,
  connect: (address: string) => invoke<void>('plugin:spp|connect', { address }),
  write: (data: string) => invoke<void>('plugin:spp|write', { data }),
  disconnect: () => invoke<void>('plugin:spp|disconnect'),
  listen: (onEvent: (event: PluginEvent) => void) => {
    const channel = new Channel<PluginEvent>();
    channel.onmessage = onEvent;
    return invoke<void>('plugin:spp|listen', { channel });
  },
};
