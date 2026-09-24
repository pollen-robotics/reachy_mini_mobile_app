/**
 * Overboard = the wheeled mobile-base add-on Reachy Mini can sit on.
 *
 * Two command paths, one command shape:
 *   - `webrtc`: normal telepresence. Drive commands ride the robot's
 *     existing WebRTC data channel as `hoverboard_drive`; the daemon's
 *     hoverboard manager relays them to the base over USB or Bluetooth
 *     (see `hoverboard.ts` for the rest of the command surface).
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

/** Daemon data-channel command (`HoverboardDriveCmd` in the daemon's protocol.py). */
export const OVERBOARD_DRIVE_MSG_TYPE = 'hoverboard_drive';

/**
 * Throttle and turn in -100..100, forward and left positive. The daemon
 * applies the base's sign conventions and caps (`max_throttle`,
 * `invert_throttle`, ...) and zeroes the drive 300 ms after the last one.
 */
export interface OverboardDriveMessage {
  type: typeof OVERBOARD_DRIVE_MSG_TYPE;
  throttle: number;
  turn: number;
  /**
   * false = no reply on success (errors still come back): saves ten
   * unread replies a second. Older daemons ignore the field and ack.
   */
  ack: false;
}

/** Link stats surfaced in the UI so the pipe can be eyeballed end-to-end. */
export interface OverboardLinkStats {
  sent: number;
}
