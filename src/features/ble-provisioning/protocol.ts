/**
 * Typed protocol layer over the raw BLE transport (`features/ble/bleWifi.ts`).
 *
 * Turns the daemon's stringly-typed GATT command replies into typed results
 * and maps `ERROR: …` strings onto our `SetupError` taxonomy. The transport
 * (scan / connect / notify / sealed-password crypto) stays in `bleWifi.ts`;
 * this module is the semantic boundary the FSM talks to.
 *
 * Response shapes (from the daemon's `bluetooth_service.py`):
 *   PIN_<pin>          → "OK: Connected" | "ERROR: Incorrect PIN"
 *   WIFI_KEYEX         → {"kid","pk","alg"} | "ERROR: …"
 *   WIFI_STATUS        → {"mode","connected","error","known"?}
 *   WIFI_SCAN          → ["SSID", …] | "ERROR: Busy" | "ERROR: …"
 *   WIFI_CONNECT_ENC … → "OK: Connecting to <ssid>" | "ERROR: Bad credentials (wrong PIN?)" | …
 */

import {
  HARDWARE_ID_CHAR,
  NETWORK_STATUS_CHAR,
  buildSealedConnect,
  readCharacteristic,
  sendCommand,
} from '@/features/ble/bleWifi';
import type { RobotIdentity, SetupError, SetupPhase } from './types';

/** Parsed `WIFI_STATUS` reply. `connected` is the joined SSID or null. */
export interface WifiStatus {
  mode: string | null; // "hotspot" | "wlan" | "disconnected" | "busy" | null
  connected: string | null; // SSID of the active network, or null
  error: string | null; // last daemon-side wifi error, or null
  known?: string[]; // saved networks (only present when authed)
}

/** A daemon reply starting with "ERROR:" - everything else is a payload. */
function isError(reply: string): boolean {
  return reply.trim().toUpperCase().startsWith('ERROR');
}

/**
 * Map a daemon `ERROR: …` reply (or a thrown transport error) onto a typed
 * `SetupError` with the right recovery target.
 */
export function toSetupError(reply: string, fallbackPhase: SetupPhase): SetupError {
  const msg = reply.replace(/^ERROR:\s*/i, '').trim();
  const lower = msg.toLowerCase();

  if (lower.includes('incorrect pin') || lower.includes('wrong pin') || lower.includes('credentials')) {
    return { code: 'wrong-pin', message: 'Incorrect setup code.', recoverPhase: 'pin' };
  }
  if (lower.includes('busy')) {
    return { code: 'busy', message: 'The robot is busy with another request.', recoverPhase: fallbackPhase };
  }
  if (lower.includes('unreachable')) {
    return {
      code: 'daemon-unreachable',
      message: 'Lost the connection to the robot.',
      recoverPhase: 'scanning',
    };
  }
  if (lower.includes('not connected') || lower.includes('authenticate')) {
    return { code: 'wrong-pin', message: 'Session expired - re-enter the setup code.', recoverPhase: 'pin' };
  }
  if (lower.includes('scan')) {
    return { code: 'wifi-scan-failed', message: "Couldn't scan for Wi-Fi networks.", recoverPhase: 'wifi-scanning' };
  }
  return { code: 'unknown', message: msg || 'Something went wrong.', recoverPhase: fallbackPhase };
}

/** Read the robot's identity (hardware id + current network status). */
export async function readIdentity(): Promise<RobotIdentity> {
  // Both reads are best-effort: an older daemon may not expose them, and we
  // don't want a missing characteristic to abort the whole setup.
  let hardwareId: string | null = null;
  let networkStatus: string | null = null;
  try {
    hardwareId = await readCharacteristic(HARDWARE_ID_CHAR);
  } catch {
    hardwareId = null;
  }
  try {
    networkStatus = await readCharacteristic(NETWORK_STATUS_CHAR);
  } catch {
    networkStatus = null;
  }
  return { hardwareId: hardwareId || null, networkStatus: networkStatus || null };
}

/** `PING` → true if the robot answers `PONG`. */
export async function ping(): Promise<boolean> {
  const r = await sendCommand('PING', 6000);
  return r.trim().toUpperCase() === 'PONG';
}

/** `PIN_<pin>` → true on `OK: Connected`. Opens the 300 s session. */
export async function authenticate(pin: string): Promise<boolean> {
  const r = await sendCommand(`PIN_${pin}`, 8000);
  return r.trim().toUpperCase().startsWith('OK');
}

/** `WIFI_KEYEX` → the raw `{kid,pk,alg}` JSON string (consumed by sealing). */
export async function keyExchange(): Promise<string> {
  const r = await sendCommand('WIFI_KEYEX', 8000);
  if (isError(r)) throw new Error(r);
  return r;
}

/** `WIFI_SCAN` → list of SSIDs (deduped, MTU-bounded by the daemon). */
export async function scanWifi(): Promise<string[]> {
  const r = await sendCommand('WIFI_SCAN', 25000);
  if (isError(r)) throw new Error(r);
  try {
    const parsed = JSON.parse(r) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

/** `WIFI_STATUS` → parsed compact status. */
export async function wifiStatus(): Promise<WifiStatus> {
  const r = await sendCommand('WIFI_STATUS', 8000);
  if (isError(r)) throw new Error(r);
  try {
    const parsed = JSON.parse(r) as Partial<WifiStatus>;
    return {
      mode: parsed.mode ?? null,
      connected: parsed.connected ?? null,
      error: parsed.error ?? null,
      known: parsed.known,
    };
  } catch {
    return { mode: null, connected: null, error: null };
  }
}

/**
 * Seal the password locally and send `WIFI_CONNECT_ENC`. Returns when the
 * daemon has accepted the request (`OK: Connecting to …`); the actual join
 * outcome must be polled via `wifiStatus()`.
 */
export async function connectSealed(
  ssid: string,
  password: string,
  pin: string,
  keyexJson: string,
): Promise<void> {
  const cmd = buildSealedConnect(ssid, password, pin, keyexJson);
  const r = await sendCommand(cmd, 20000);
  if (isError(r)) throw new Error(r);
}
