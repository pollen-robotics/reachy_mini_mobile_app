import { useEffect, useState } from 'react';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import {
  ANTENNA_JOINT_LABELS,
  ANTENNA_JOINT_TOLERANCE_RAD,
  HEAD_JOINT_LABELS,
  HEAD_JOINT_TOLERANCE_RAD,
  NECK_JOINT_TOLERANCE_RAD,
  SLEEP_ANTENNAS_JOINT_POSITIONS,
  SLEEP_HEAD_JOINT_POSITIONS,
  SLEEP_MATCH_EXIT_MARGIN_RAD,
} from './poses';

export interface SleepPositionCheck {
  /** True once the daemon has sent per-motor joint positions at least once.
   *  When false (older daemon), callers should fail open (don't block). */
  hasData: boolean;
  /** True when every motor is within tolerance of its sleep target. */
  inPosition: boolean;
  /** Human-facing names of the motors currently out of sleep position. */
  offMotors: string[];
}

interface StateDetail {
  head_joint_positions?: number[];
  antennas_joint_positions?: number[];
}

interface StateCapableRobot extends EventTarget {
  robotState?: StateDetail;
}

const IDLE: SleepPositionCheck = { hasData: false, inPosition: false, offMotors: [] };

/** One motor's sleep target + name + "in position" tolerance (radians). */
interface MotorSpec {
  target: number;
  tolerance: number;
  label: string;
}

/**
 * Flattened, index-stable list of every checked motor: base rotation, the 6
 * neck (Stewart) motors, then the 2 antennas. The neck motors get a much looser
 * tolerance (a small head tilt spreads across all six, so they're hard to
 * hand-place precisely).
 */
const MOTOR_SPECS: MotorSpec[] = [
  { target: SLEEP_HEAD_JOINT_POSITIONS[0]!, tolerance: HEAD_JOINT_TOLERANCE_RAD, label: HEAD_JOINT_LABELS[0]! },
  ...[1, 2, 3, 4, 5, 6].map(i => ({
    target: SLEEP_HEAD_JOINT_POSITIONS[i]!,
    tolerance: NECK_JOINT_TOLERANCE_RAD,
    label: HEAD_JOINT_LABELS[i]!,
  })),
  ...[0, 1].map(i => ({
    target: SLEEP_ANTENNAS_JOINT_POSITIONS[i]!,
    tolerance: ANTENNA_JOINT_TOLERANCE_RAD,
    label: ANTENNA_JOINT_LABELS[i]!,
  })),
];

/**
 * Watches the robot's per-motor joint positions (streamed on the `state`
 * event) and compares them to the daemon's sleep pose, motor by motor. No
 * extra polling: it rides the state feed the live viewer already drives.
 *
 * Hysteresis is GLOBAL (a single matched/not-matched state), which is the key
 * to it being robust: the robot must have every motor in position AT THE SAME
 * TIME to count as tucked in - not each motor individually, at some point
 * (per-motor latching would let unrelated fiddling drift everything to "good").
 *  - while NOT matched, every motor is checked at its tight `tolerance`;
 *  - once matched, each motor gets a SMALL fixed extra margin
 *    (`SLEEP_MATCH_EXIT_MARGIN_RAD`, ~7deg) before it's flagged again - just
 *    enough to stop boundary flicker, NOT enough to freeze the check. Move a
 *    joint back out by more than that and the error re-triggers immediately.
 * `offMotors` is always reported at the active threshold, so it says exactly
 * which motors still need adjusting.
 */
export function useSleepPositionCheck(session: RobotSessionHandle): SleepPositionCheck {
  const [check, setCheck] = useState<SleepPositionCheck>(IDLE);
  const { getRobot } = session;

  useEffect(() => {
    const robot = getRobot() as StateCapableRobot | null;
    if (!robot) return;

    // Single stable match state (kept across events for the hysteresis).
    let matched = false;

    const update = (detail: StateDetail | undefined) => {
      const head = detail?.head_joint_positions;
      const antennas = detail?.antennas_joint_positions;
      // No per-motor data yet (older daemon): stay IDLE so callers fail open.
      if (!Array.isArray(head) || head.length !== 7 || !Array.isArray(antennas) || antennas.length !== 2) {
        return;
      }

      const values = [...head, ...antennas]; // index-aligned to MOTOR_SPECS
      // Tight tolerance to ENTER the match; once matched, add a small fixed
      // margin to LEAVE it (light hysteresis, only to avoid boundary flicker).
      const margin = matched ? SLEEP_MATCH_EXIT_MARGIN_RAD : 0;
      const offMotors: string[] = [];

      for (let i = 0; i < MOTOR_SPECS.length; i++) {
        const spec = MOTOR_SPECS[i]!;
        if (Math.abs(values[i]! - spec.target) > spec.tolerance + margin) {
          offMotors.push(spec.label);
        }
      }

      matched = offMotors.length === 0;
      setCheck({ hasData: true, inPosition: matched, offMotors });
    };

    const onState = (e: Event) => update((e as CustomEvent).detail);

    robot.addEventListener('state', onState);
    update(robot.robotState);

    return () => {
      robot.removeEventListener('state', onState);
    };
  }, [getRobot]);

  return check;
}
