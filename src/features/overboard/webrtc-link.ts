/**
 * Overboard drive commands over the robot's WebRTC data channel.
 *
 * Wire format (legacy `{type: ...}` command, same channel as
 * `set_target` & co):
 *
 *   {"type": "overboard_drive", "linear": 0.42, "angular": -0.1, "seq": 17}
 *
 * The daemon doesn't know this type yet: `_handle_webrtc_message` fails
 * pydantic validation, logs `WebRTC invalid command: ...` and replies
 * `{"error": "Invalid command: ..."}`. The SDK re-emits that reply as an
 * `error` event (`source: 'robot'`), which the engine only logs - so the
 * rejection is harmless and we count it as an "echo": proof that the
 * command crossed the whole phone → central/LAN → daemon pipe.
 */
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { emptyStats, type OverboardLink } from './link';
import { OVERBOARD_DRIVE_MSG_TYPE, type OverboardDriveMessage } from './types';

export function createOverboardWebRtcLink(
  getRobot: () => ReachyMiniInstance | null,
): OverboardLink {
  const stats = emptyStats();
  let seq = 0;
  let listenedRobot: ReachyMiniInstance | null = null;
  let disposed = false;

  const onRobotError = (event: Event) => {
    const detail = (event as CustomEvent<{ source?: string; error?: unknown }>).detail;
    if (detail?.source !== 'robot') return;
    const text = String(detail.error ?? '');
    if (!text.includes(OVERBOARD_DRIVE_MSG_TYPE)) return;
    stats.echoes += 1;
    // The raw pydantic dump lists every known command; keep the gist.
    stats.lastEcho = text.includes('does not match any of the expected tags')
      ? 'rejected as unknown type (expected until the daemon add-on lands)'
      : text.length > 160
        ? `${text.slice(0, 160)}…`
        : text;
    stats.lastEchoAt = Date.now();
  };

  /** Follow the SDK instance across re-dials / reacquires. */
  const track = (robot: ReachyMiniInstance | null) => {
    if (robot === listenedRobot) return;
    listenedRobot?.removeEventListener('error', onRobotError);
    listenedRobot = robot;
    listenedRobot?.addEventListener('error', onRobotError);
  };

  return {
    mode: 'webrtc',
    send(drive) {
      if (disposed) return;
      const robot = getRobot();
      track(robot);
      if (!robot) return;
      const msg: OverboardDriveMessage = { type: OVERBOARD_DRIVE_MSG_TYPE, seq: ++seq, ...drive };
      if (robot.sendRaw(msg)) stats.sent += 1;
    },
    getStats: () => ({ ...stats }),
    dispose() {
      disposed = true;
      track(null);
    },
  };
}
