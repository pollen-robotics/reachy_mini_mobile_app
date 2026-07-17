import type { LivePose } from './useRobotPose';

/**
 * Canonical robot poses, ported 1:1 from the daemon
 * (`reachy_mini/src/reachy_mini/reachy_mini.py`). Keep these in sync if the
 * daemon's constants change.
 *
 * `head` is a 4x4 homogeneous matrix (row-major, flattened to 16 numbers) in
 * the robot frame - exactly the shape the daemon streams as `head_pose` and
 * that the 3D viewer consumes. `antennas` is `[rightRad, leftRad]`.
 */

/** Neutral upright pose: identity head, antennas ~vertical (`INIT_*`). */
export const INIT_POSE: LivePose = {
  head: [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ],
  body_yaw: 0,
  antennas: [-0.1745, 0.1745],
};

/**
 * Sleep / rest pose: head tucked down-and-forward (~24deg pitch, -44mm Z),
 * antennas folded back. Mirrors `SLEEP_HEAD_POSE` +
 * `SLEEP_ANTENNAS_JOINT_POSITIONS`.
 */
export const SLEEP_POSE: LivePose = {
  head: [
    0.911, 0.004, 0.413, -0.021,
    -0.004, 1.0, -0.001, 0.001,
    -0.413, -0.001, 0.911, -0.044,
    0.0, 0.0, 0.0, 1.0,
  ],
  body_yaw: 0,
  antennas: [-3.05, 3.05],
};

// --- Per-motor sleep targets (for the "is it tucked in?" check) ------------
// Head joints: body yaw at [0], the 6 neck (Stewart) motors at [1..6].
// Antennas: [right, left].
//
// IMPORTANT: these are `IK(SLEEP_HEAD_POSE)`, i.e. the joint solution for the
// SAME head matrix the daemon's `goto_sleep` drives to (`goto_target(
// SLEEP_HEAD_POSE)`) and that the welcome-step ghost renders (`SLEEP_POSE.head`
// = `SLEEP_HEAD_POSE`). So the wizard's EXAMPLE (ghost) and its EXPECTATION
// (this check) both reference the exact pose `goto_sleep` targets.
//
// They are deliberately NOT the daemon's `SLEEP_HEAD_JOINT_POSITIONS` constant:
// that one is a different, more forward-tilted pose (the limp/at-rest joints,
// ~47deg off on two neck motors) and does NOT match the `goto_sleep` command
// nor the ghost - matching the ghost would then never satisfy the check. Do NOT
// "re-sync" these to the daemon's joint constant. Recompute via the daemon
// kinematics if `SLEEP_HEAD_POSE` ever changes:
//   AnalyticalKinematics().ik(SLEEP_HEAD_POSE)
export const SLEEP_HEAD_JOINT_POSITIONS = [
  0,
  -0.17062380590244164,
  0.83648773098012,
  -0.12343185781944577,
  0.08757153985787802,
  -0.8121685549523017,
  0.178508447104627,
];

export const SLEEP_ANTENNAS_JOINT_POSITIONS = [-3.05, 3.05];

/** Human-facing names for the 7 head joints (index-aligned). */
export const HEAD_JOINT_LABELS = [
  'Base rotation',
  'Neck motor 1',
  'Neck motor 2',
  'Neck motor 3',
  'Neck motor 4',
  'Neck motor 5',
  'Neck motor 6',
];

/** Human-facing names for the 2 antenna joints (index-aligned). */
export const ANTENNA_JOINT_LABELS = ['Right antenna', 'Left antenna'];

// How far a motor may sit from its sleep target before we flag it (radians).
// Kept deliberately loose: the check only needs the robot roughly tucked in by
// hand (it's not a precise calibration), and too-tight a tolerance leaves users
// fighting to place joints exactly right.
//
// The 6 neck (Stewart) motors are the hardest to place by hand - a small head
// tilt spreads across all of them - so they get a much looser tolerance than
// the base rotation.
export const HEAD_JOINT_TOLERANCE_RAD = 0.35; // ~14deg (base rotation only)
export const NECK_JOINT_TOLERANCE_RAD = 0.55; // ~20deg (the 6 neck/Stewart motors)
export const ANTENNA_JOINT_TOLERANCE_RAD = 0.35; // ~20deg (antennas rest near their limit)

// Hysteresis for the "in sleep position" check. Motor readings jitter, so a
// single tolerance boundary makes `inPosition` flip when a joint sits on the
// edge. Once matched we therefore allow each motor to drift by this SMALL fixed
// margin (radians) before flagging it again. It's deliberately additive (not a
// multiplier on the per-motor tolerances): the intent is only to
// kill boundary flicker, NOT to freeze the check - moving a joint back out by
// more than a few degrees must re-trigger the error.
export const SLEEP_MATCH_EXIT_MARGIN_RAD = 0.12; // ~7deg
