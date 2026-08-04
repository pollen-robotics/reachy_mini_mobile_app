import { useEffect, useRef } from 'react';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';

/**
 * Live robot pose pulled off the WebRTC data channel, in the robot's own
 * frame - exactly the shape the 3D viewer consumes:
 *  - `head`: flattened 4x4 head pose (16 numbers, row-major), or null.
 *  - `body_yaw`: signed radians around the vertical axis.
 *  - `antennas`: `[rightRad, leftRad]`, or null.
 */
export interface LivePose {
  head: number[] | null;
  body_yaw: number;
  antennas: number[] | null;
}

/**
 * Runtime surface of the SDK we lean on for the live pose. The typed
 * `ReachyMiniInstance` doesn't expose these (they're internal), but the SDK
 * emits a `state` CustomEvent on every `get_state` reply and exposes the last
 * snapshot on `robotState`. We can also nudge the poll rate up via
 * `requestState()` while the viewer is on screen for a smoother mirror.
 */
interface StateCapableRobot extends EventTarget {
  requestState?: () => boolean;
  subscribePose?: () => boolean;
  unsubscribePose?: () => boolean;
  robotState?: {
    head?: number[];
    body_yaw?: number;
    antennas?: number[];
  };
}

/**
 * Subscribe to the robot's live pose while a component is mounted and expose
 * it through a ref (no re-render per update - the 3D loop reads `.current`).
 */
export function useRobotPose(session: RobotSessionHandle): React.RefObject<LivePose> {
  const poseRef = useRef<LivePose>({ head: null, body_yaw: 0, antennas: null });

  // Depend on the stable `getRobot` callback, not the `session` handle, which
  // is a fresh object literal on every render (would re-subscribe each frame).
  const { getRobot } = session;
  useEffect(() => {
    const robot = getRobot() as StateCapableRobot | null;
    if (!robot) return;

    const apply = (d: { head?: number[]; body_yaw?: number; antennas?: number[] } | undefined) => {
      if (!d) return;
      if (Array.isArray(d.head) && d.head.length === 16) poseRef.current.head = d.head;
      if (typeof d.body_yaw === 'number') poseRef.current.body_yaw = d.body_yaw;
      if (Array.isArray(d.antennas) && d.antennas.length === 2) poseRef.current.antennas = d.antennas;
    };

    const onState = (e: Event) => apply((e as CustomEvent).detail);
    robot.addEventListener('state', onState);

    // Seed from the last snapshot so the robot appears posed immediately.
    apply(robot.robotState);

    // Subscribe to the daemon's ~30 Hz pose push over the dedicated
    // unreliable "pose" channel (fired as `state` events above) instead of
    // polling get_state on a fast timer - that round-tripped over the
    // reliable channel and lagged badly on Wi-Fi. One kick primes the mirror
    // immediately; on an older daemon (no pose channel / no subscribe_pose)
    // the SDK's own 2 Hz self-poll keeps it (slowly) updated.
    robot.subscribePose?.();
    robot.requestState?.();

    return () => {
      robot.removeEventListener('state', onState);
      robot.unsubscribePose?.();
    };
  }, [getRobot]);

  return poseRef;
}

/**
 * A fixed pose source (no daemon, no data channel): hands the viewer a ref to
 * a constant pose. Useful for reference/target views like the sleep position.
 * If `pose` changes identity, the ref is updated so the viewer eases into it.
 */
export function useStaticPose(pose: LivePose): React.RefObject<LivePose> {
  const poseRef = useRef<LivePose>(pose);
  useEffect(() => {
    poseRef.current = pose;
  }, [pose]);
  return poseRef;
}
