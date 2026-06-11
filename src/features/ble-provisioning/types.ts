/**
 * Types for the first-time Wi-Fi setup (BLE provisioning) flow.
 *
 * The wizard is a small state machine: a brand-new Reachy Mini Wireless is
 * provisioned onto the user's Wi-Fi entirely over Bluetooth (see the daemon
 * doc `BLE_WIFI_PROVISIONING.md` and `docs/FIRST_TIME_SETUP_PLAN.md`).
 */

import type { CentralRobotEntry } from '@/features/auth/fetchRobotsFromCentral';

/**
 * Linear phases of the setup wizard. The UI maps these to a 4-step
 * progress indicator (Pair / Network / Connect / Ready); the FSM itself
 * tracks the finer-grained phase below.
 */
export type SetupPhase =
  | 'permission' // explain + request OS Bluetooth permission
  | 'scanning' // BLE scan for advertising robots
  | 'connecting' // GATT connect + read identity (hwid, net status)
  | 'pin' // user enters the 5-char setup code
  | 'authenticating' // PIN_ + WIFI_KEYEX in flight
  | 'wifi-scanning' // WIFI_SCAN in flight (~10 s)
  | 'wifi-pick' // choose an SSID
  | 'wifi-password' // enter the Wi-Fi password
  | 'wifi-connecting' // sealed connect + poll WIFI_STATUS
  | 'linking-account' // robot-side HF OAuth (open browser) so it can register
  | 'central-waiting' // joined Wi-Fi, waiting to appear on HF central
  | 'done' // success - robot reachable
  | 'error'; // recoverable failure (see SetupError.recoverPhase)

/** The four perceived steps shown in the wizard header. */
export type SetupStage = 'pair' | 'network' | 'connect' | 'ready';

/** Map a fine-grained phase to its header stage + 0-based index. */
export function stageForPhase(phase: SetupPhase): { stage: SetupStage; index: number } {
  switch (phase) {
    case 'permission':
    case 'scanning':
    case 'connecting':
    case 'pin':
    case 'authenticating':
      return { stage: 'pair', index: 0 };
    case 'wifi-scanning':
    case 'wifi-pick':
    case 'wifi-password':
      return { stage: 'network', index: 1 };
    case 'wifi-connecting':
    case 'linking-account':
    case 'central-waiting':
      return { stage: 'connect', index: 2 };
    case 'done':
      return { stage: 'ready', index: 3 };
    case 'error':
    default:
      return { stage: 'pair', index: 0 };
  }
}

/**
 * What we learn about the robot once connected over BLE (the advert itself
 * carries no identity in the v2 daemon - all robots advertise "ReachyMini").
 */
export interface RobotIdentity {
  /** SHA-256 prefix of the audio serial, read from the HARDWARE_ID GATT char.
   *  Matches `meta.hardware_id` in the HF central listing - our bridge between
   *  the BLE world and the central world. `null` when the daemon doesn't
   *  expose it. */
  hardwareId: string | null;
  /** Raw NETWORK_STATUS read ("OFFLINE" / "HOTSPOT …" / "CONNECTED …"). */
  networkStatus: string | null;
}

/** A Wi-Fi network the robot can see (the daemon scan returns SSIDs only). */
export interface WifiNetwork {
  ssid: string;
  /** We can't infer security from the SSID-only scan; treat every network as
   *  secured (ask for a password) and let the user pick "open" implicitly by
   *  leaving it blank on a network that rejects the attempt. */
  secured: boolean;
}

/**
 * A recoverable error, mapped from a daemon `ERROR: …` reply or a local
 * failure (permission, BLE drop). `recoverPhase` tells the wizard which step
 * to bounce back to so the user doesn't restart the whole flow.
 */
export interface SetupError {
  code:
    | 'permission-denied'
    | 'no-devices'
    | 'connect-failed'
    | 'wrong-pin'
    | 'wifi-scan-failed'
    | 'wrong-password'
    | 'busy'
    | 'daemon-unreachable'
    | 'ble-dropped'
    | 'timeout'
    | 'unknown';
  /** Human-readable, shown verbatim in the error step. */
  message: string;
  /** Where "Try again" should take the user. */
  recoverPhase: SetupPhase;
}

/** Final payload handed back to the host when provisioning succeeds. */
export interface SetupResult {
  hardwareId: string | null;
  /** The matching central listing, when it appeared before we gave up
   *  waiting. `null` means "Wi-Fi joined but not yet visible on central" -
   *  the user is sent back to the list to wait it out. */
  robot: CentralRobotEntry | null;
}
