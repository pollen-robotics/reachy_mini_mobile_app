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
  type RobotNetInfo,
  buildSealedConnect,
  parseNetworkStatus,
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
 * A reply the robot's BLE service didn't recognise. Its `_handle_command`
 * falls through to `ECHO: <cmd>` for any unknown command, so an `ECHO` reply
 * means "this firmware is too old to support that command" - distinct from a
 * genuine empty / error result (which an old firmware can't even express).
 */
function isUnsupported(reply: string): boolean {
  return reply.trim().toUpperCase().startsWith('ECHO');
}

/**
 * Daemon version that first shipped the BLE Wi-Fi setup commands. `WIFI_SCAN`
 * and `UPDATE_CHECK` both landed together in v1.8.2 (#1168 / #1172); a robot
 * older than this echoes those commands back instead of running them, which is
 * why an outdated robot used to surface as a silent "0 networks".
 */
export const MIN_WIFI_SETUP_VERSION = '1.8.2';

/**
 * Thrown when the robot's BLE service is too old to know a setup command: its
 * `_handle_command` echoed the command back instead of running it. We learn
 * this from the SYNCHRONOUS RESPONSE read right after the write (the robot
 * always writes a reply before returning), so it's a definitive signal, not an
 * inference from silence - a true no-reply is a transport timeout handled
 * elsewhere. There's no point asking for the version to confirm: `UPDATE_CHECK`
 * shares the same v1.8.2 floor, so a robot that echoes WIFI_SCAN can't report
 * its version either.
 */
export class RobotOutdatedError extends Error {
  constructor() {
    super('robot-outdated');
    this.name = 'RobotOutdatedError';
  }
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

/** Read the robot's identity (hardware id). */
export async function readIdentity(): Promise<RobotIdentity> {
  // Best-effort: an older daemon may not expose the characteristic, and we
  // don't want a missing read to abort the whole setup.
  let hardwareId: string | null = null;
  try {
    hardwareId = await readCharacteristic(HARDWARE_ID_CHAR);
  } catch {
    hardwareId = null;
  }
  return { hardwareId: hardwareId || null };
}

/**
 * Read + parse the live NETWORK_STATUS characteristic (cdef4): the robot's
 * connection mode and, once it's on a real network, its LAN IPv4.
 *
 * Used right after a Wi-Fi join to learn the address the robot just got, so we
 * can reach its OAuth endpoint by IP instead of the flakier `reachy-mini.local`
 * mDNS name. Best-effort: throws only on a transport/read error, which the
 * caller treats as "fall back to mDNS".
 */
export async function readNetworkInfo(): Promise<RobotNetInfo> {
  return parseNetworkStatus(await readCharacteristic(NETWORK_STATUS_CHAR));
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
  // A pre-1.8.2 robot doesn't know WIFI_SCAN and echoes it back. Catch it here
  // so it surfaces as a clear "robot outdated" error: without this the
  // JSON.parse below throws and we'd return [] - silently indistinguishable
  // from "no networks nearby".
  if (isUnsupported(r)) throw new RobotOutdatedError();
  if (isError(r)) throw new Error(r);
  try {
    const parsed = JSON.parse(r) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

// Emotions-library move names played as onboarding cues over BLE. All ship in
// the robot's pre-downloaded library (`pollen-robotics/reachy-mini-emotions-
// library`), hyphenated-lowercase by convention.
/** Identify move (motion + sound) played when a robot is picked from the scan list. */
export const IDENTIFY_MOVE = 'toc-toc-toc';
/** Idle "I'm busy" cue played while the robot joins Wi-Fi and links its account. */
export const WAITING_MOVE = 'waiting';

/**
 * `PLAY <move>` → plays a named recorded move (motion + bundled sound) from the
 * robot's emotions library. Public BLE command (no PIN), used for onboarding
 * cues (identify chirp, waiting/sleep). Best-effort: swallow everything, a
 * failed cue must never block setup. Kept SEQUENTIAL on the shared
 * command/response channel by callers.
 */
export async function play(moveName: string): Promise<void> {
  try {
    await sendCommand(`PLAY ${moveName}`, 6000);
  } catch {
    // non-critical: ignore
  }
}

/**
 * `SLEEP` → plays the daemon's canonical goto-sleep trajectory: interpolate to
 * the EXACT sleep pose (+ go_sleep sound), then release torque. Public BLE
 * command (no PIN), used as the end-of-setup "settle to sleep" cue so the
 * first-wake-up wizard opens on a robot placed precisely in its sleep pose -
 * the exact canonical pose the wizard's ghost compares against.
 * Best-effort like `play`: a failed cue must never block the finish.
 */
export async function gotoSleep(): Promise<void> {
  try {
    await sendCommand('SLEEP', 6000);
  } catch {
    // non-critical: ignore
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
