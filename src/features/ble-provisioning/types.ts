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
 * progress indicator (Pair / Network / Connect / Ready) via `PHASE_FRACTION`
 * in the screen; the FSM itself tracks the finer-grained phase below.
 *
 * The OS Bluetooth permission is requested implicitly by the first scan (no
 * dedicated `permission` phase), and the Wi-Fi password is entered inline in
 * the `wifi-pick` step (no separate `wifi-password` phase).
 */
export type SetupPhase =
  | 'scanning' // BLE scan for advertising robots
  | 'connecting' // GATT connect + read identity (hwid)
  | 'pin' // user enters the 5-char setup code
  | 'authenticating' // PIN_ + WIFI_KEYEX in flight
  | 'wifi-already-connected' // robot already on Wi-Fi: offer to skip provisioning
  | 'wifi-scanning' // WIFI_SCAN in flight (~10 s)
  | 'wifi-pick' // choose an SSID + enter its password inline
  | 'wifi-connecting' // sealed connect + poll WIFI_STATUS
  | 'linking-account' // robot-side HF OAuth (open browser) so it can register
  | 'device-code-waiting' // redirect-free (device-code) HF sign-in: browser open, polling the robot
  | 'central-waiting' // joined Wi-Fi, waiting to appear on HF central (last step)
  | 'done' // success - robot reachable; naming happens in the first wake-up wizard
  | 'error'; // recoverable failure (see SetupError.recoverPhase)

/**
 * What we learn about the robot once connected over BLE. The advert carries no
 * per-robot identity (all robots advertise "ReachyMini"); the canonical
 * identity below is read post-connect from the GATT characteristics.
 */
export interface RobotIdentity {
  /** SHA-256 prefix of the audio serial, read from the HARDWARE_ID GATT char.
   *  Matches `meta.hardware_id` in the HF central listing - our bridge between
   *  the BLE world and the central world. `null` when the daemon doesn't
   *  expose it. */
  hardwareId: string | null;
}

/**
 * A recoverable error, mapped from a daemon `ERROR: …` reply or a local
 * failure (permission, BLE drop). `recoverPhase` tells the wizard which step
 * to bounce back to so the user doesn't restart the whole flow.
 */
export interface SetupError {
  code:
    | 'permission-denied'
    | 'connect-failed'
    | 'wrong-pin'
    | 'wifi-scan-failed'
    | 'robot-outdated'
    | 'wrong-password'
    | 'busy'
    | 'daemon-unreachable'
    | 'ble-dropped'
    | 'timeout'
    // No usable LAN IP for the robot was read over BLE, so we can't reach its
    // OAuth endpoint. We reach the robot strictly by IP (mDNS is unreliable on
    // mobile and never used), so a missing IP is a hard, explicit failure.
    | 'robot-ip-unknown'
    // The robot never registered on HF central after the OAuth step, so we
    // could not confirm sign-in actually completed. Treated as a recoverable
    // failure instead of a silent success.
    | 'oauth-unconfirmed'
    | 'unknown';
  /** Human-readable, shown verbatim in the error step. */
  message: string;
  /** Where "Try again" should take the user. */
  recoverPhase: SetupPhase;
}

/** Final payload handed back to the host when provisioning succeeds. */
export interface SetupResult {
  hardwareId: string | null;
  /** The matching central listing. Always non-null on success now: we only
   *  reach `done` once the robot has actually registered on central (that's
   *  our OAuth-completed signal). Kept nullable for the type's history. */
  robot: CentralRobotEntry | null;
}
