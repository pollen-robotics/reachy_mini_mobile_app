/**
 * Overboard drive commands over the robot's WebRTC data channel.
 *
 * Wire format (legacy `{type: ...}` command, same channel as
 * `set_target` & co):
 *
 *   {"type": "hoverboard_drive", "throttle": 42, "turn": -10}
 *
 * Fire-and-forget: the daemon answers every frame with
 * `{"status": "ok"|..., "command": "hoverboard_drive"}` (or `{"error": ...}`,
 * typically "hoverboard not connected"), but the drive path never waits on
 * it. Link health comes from the status poll in `useHoverboardBase`.
 */
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { emptyStats, type OverboardLink } from './link';
import { OVERBOARD_DRIVE_MSG_TYPE, type OverboardDrive, type OverboardDriveMessage } from './types';

/** Normalised [-1, 1] drive → the daemon's -100..100 throttle / turn. */
export function toDriveMessage(drive: OverboardDrive): OverboardDriveMessage {
  const scale = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 1000) / 10 || 0;
  return { type: OVERBOARD_DRIVE_MSG_TYPE, throttle: scale(drive.linear), turn: scale(drive.angular) };
}

export function createOverboardWebRtcLink(
  getRobot: () => ReachyMiniInstance | null,
): OverboardLink {
  const stats = emptyStats();

  return {
    mode: 'webrtc',
    send(drive) {
      const robot = getRobot();
      if (!robot) return;
      if (robot.sendRaw(toDriveMessage(drive))) stats.sent += 1;
    },
    getStats: () => ({ ...stats }),
    // Nothing to release, and deliberately no "disposed" latch: React
    // StrictMode runs the owner's unmount cleanup once in dev and keeps
    // the same link instance, which a latch would silence for good.
    dispose() {},
  };
}
