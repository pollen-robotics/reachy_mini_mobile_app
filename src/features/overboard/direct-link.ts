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
 * Signs: the app's drive is forward / left positive; what reaches the
 * wheels depends on the base (wiring, INVERT_WHEEL flags). Defaults per
 * base address in `defaultWireSigns`, switchable on the screen.
 *
 * Safety: the firmware has no link deadman and keeps the last T/R if the
 * link drops. The app zeroes the drive whenever it stops driving (release,
 * app backgrounded, screen left), but a radio loss mid-drive can't be
 * caught from here.
 */
import { Channel, invoke } from '@tauri-apps/api/core';

import type { HoverboardFirmwareState } from './hoverboard';
import type { OverboardDrive } from './types';

export interface WireSigns {
  throttle: 1 | -1;
  turn: 1 | -1;
}

/**
 * Both flipped on the wire, as measured on Rémi's prototype (the daemon's
 * invert_throttle=True and FIRMWARE_TURN_SIGN=-1). Used for every base: the
 * prototype's swapped INVERT_WHEEL flags compensate wiring that made it
 * unable to balance with the stock flags, so any base that balances maps
 * T and R to the wheels the same way. Overridable per base on the screen.
 */
export function defaultWireSigns(_address: string | null): WireSigns {
  return { throttle: -1, turn: -1 };
}

/** Plugin rejections arrive as strings or `{message}` objects, never Errors. */
export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Bluetooth name the base advertises; the field firmware appends its number (rmini_wheels_3). */
export const BASE_DEVICE_NAME = 'rmini_wheels';

export function isBaseName(name: string): boolean {
  return name === BASE_DEVICE_NAME || name.startsWith(`${BASE_DEVICE_NAME}_`);
}

export interface BondedDevice {
  name: string;
  address: string;
  /** Paired with this phone; an unpaired base pairs on Connect. */
  bonded?: boolean;
}

export interface DirectTelemetry {
  state: HoverboardFirmwareState | string;
  tiltDeg: number;
  batteryV: number | null;
  /** Date.now() of the status line. */
  at: number;
}

type PluginEvent = { type: 'line'; line: string } | { type: 'disconnected'; reason: string };

export function encodeDrive(drive: OverboardDrive, signs: WireSigns): string {
  const pct = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 100) || 0;
  return `T${pct(drive.linear) * signs.throttle || 0}\nR${pct(drive.angular) * signs.turn || 0}\n`;
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
  /** Classic Bluetooth discovery; finds bases that aren't paired yet. */
  scan: async (seconds = 8): Promise<BondedDevice[]> =>
    (await invoke<{ devices: BondedDevice[] }>('plugin:spp|scan', { seconds })).devices,
  connect: (address: string) => invoke<void>('plugin:spp|connect', { address }),
  write: (data: string) => invoke<void>('plugin:spp|write', { data }),
  disconnect: () => invoke<void>('plugin:spp|disconnect'),
  listen: (onEvent: (event: PluginEvent) => void) => {
    const channel = new Channel<PluginEvent>();
    channel.onmessage = onEvent;
    return invoke<void>('plugin:spp|listen', { channel });
  },
};
