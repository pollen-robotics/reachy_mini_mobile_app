/**
 * Overboard = the wheeled mobile-base add-on Reachy Mini can sit on.
 *
 * Two command paths, one command shape:
 *   - `webrtc`: normal telepresence. Drive commands ride the robot's
 *     existing WebRTC data channel; the daemon forwards them to the
 *     overboard. Until the daemon-side add-on lands, the daemon rejects
 *     them as unknown (`WebRTC invalid command: ...` in journalctl), which
 *     is enough to validate the phone → robot half of the pipe.
 *   - `ble`: manual mode. The telepresence session is released and the
 *     phone talks to the overboard directly over Bluetooth LE (stubbed).
 */

/**
 * Normalised drive command, both axes in [-1, 1].
 *   linear  > 0 = forward
 *   angular > 0 = turn left (counter-clockwise seen from above, ROS REP-103)
 */
export interface OverboardDrive {
  linear: number;
  angular: number;
}

export const STOP: OverboardDrive = { linear: 0, angular: 0 };

export type OverboardMode = 'webrtc' | 'ble';

/** Data-channel message type for the (future) daemon add-on. */
export const OVERBOARD_DRIVE_MSG_TYPE = 'overboard_drive';

export interface OverboardDriveMessage extends OverboardDrive {
  type: typeof OVERBOARD_DRIVE_MSG_TYPE;
  /** Monotonic per-link counter so the daemon side can spot drops/reordering. */
  seq: number;
}

/** Link stats surfaced in the UI so the pipe can be eyeballed end-to-end. */
export interface OverboardLinkStats {
  sent: number;
  /** Daemon replies mentioning the overboard command (today: "invalid command"). */
  echoes: number;
  lastEcho: string | null;
  lastEchoAt: number | null;
}
