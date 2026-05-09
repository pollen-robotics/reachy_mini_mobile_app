/**
 * Head joystick configuration knobs.
 *
 * Hardware limits and tuning constants for the manual head control
 * surface. Centralised here so the joystick component, the velocity
 * controller hook, and any future preset / autopilot can read from
 * a single source of truth (and so that bumping a value during HW
 * tuning is a 1-line change).
 *
 * Sign conventions
 * ────────────────
 * Joystick output is screen-space normalised to `[-1, 1]`:
 *   - `x > 0`  ⇒ thumb pushed right
 *   - `y > 0`  ⇒ thumb pushed DOWN (screen Y points down)
 *
 * Robot head conventions follow `setHeadRpyDeg(roll, pitch, yaw)`
 * (`reachy-mini.js` line ~768) AS OBSERVED on real Reachy Mini
 * hardware:
 *   - `yaw > 0`   ⇒ head turns LEFT (right-handed Z-up)
 *   - `pitch > 0` ⇒ head tilts DOWN (chin down) — measured on HW,
 *                   inverse of the aerospace convention an earlier
 *                   version of this file assumed.
 *   - `roll`      ⇒ unused by the joystick (kept at 0)
 *
 * Mapping (driven from these conventions in `useHeadVelocityControl`):
 *   - push joystick RIGHT (x > 0) ⇒ user wants to look RIGHT ⇒ yaw target DECREASES
 *   - push joystick UP    (y < 0) ⇒ user wants to look UP    ⇒ pitch target DECREASES
 *
 * The "look up" / "look down" directions match the user's natural
 * mental model: pushing the thumb up makes the head look up. The
 * sign of the actual pitch number on the wire is a robot-frame
 * detail kept inside this module.
 *
 * If a future HW change inverts an axis again, flip the
 * corresponding sign in `useHeadVelocityControl` rather than here -
 * these constants are pure magnitudes / signed bounds, not
 * direction-dependent.
 */

/**
 * Soft clamps applied to the integrated yaw / pitch state. The
 * daemon also clamps to its own physical limits, but doing it here
 * means the visual feedback of the joystick reflects "I'm at the
 * edge" instead of silently sending unreachable targets.
 *
 * Conservative values pending HW characterisation: the actual head
 * mechanism on Reachy Mini has a wider yaw range, but capping at
 * ±50° keeps the user in a region where the head IK is comfortable
 * and we don't wash through the antennas.
 *
 * Pitch bounds reflect the robot-frame sign convention documented
 * above (`pitch > 0` = chin down). `MAX` is the most-negative value
 * we'll send (chin fully up), `MIN` is the most-positive value
 * (chin fully down). Names use raw signed-bound semantics rather
 * than UP/DOWN labels, which would just push the convention
 * confusion one level deeper.
 */
export const HEAD_YAW_LIMIT_DEG = 50;
export const HEAD_PITCH_MAX_DEG = 25;
export const HEAD_PITCH_MIN_DEG = -20;

/**
 * Maximum angular velocity at full joystick deflection (after the
 * quadratic curve). Tuned so a held push sweeps the full yaw range
 * in roughly 1.5 s - fast enough to feel responsive, slow enough
 * that micro-cadrages stay achievable with the centre-of-stick
 * sensitivity reduced by the quadratic mapping.
 */
export const MAX_YAW_DEG_PER_SEC = 60;
export const MAX_PITCH_DEG_PER_SEC = 40;

/**
 * Joystick deadzone. Anything below this magnitude in the
 * normalised `[-1, 1]` space is treated as zero. Compensates for
 * sloppy thumb-down events where the touch starts a few pixels off
 * centre, and avoids drift when the user is "just resting" the
 * thumb on the joystick.
 */
export const JOYSTICK_DEADZONE = 0.1;

/**
 * Control loop tick. The velocity controller integrates joystick
 * deflection into yaw/pitch targets at this rate AND fires a
 * `setHeadRpyDeg` per tick (subject to the delta threshold below),
 * giving the robot a 20 Hz target stream.
 *
 * Higher = smoother but more DataChannel pressure (which also
 * carries audio + 50 Hz joint_positions / head_pose pushes from the
 * daemon). 50 ms is the empirical sweet spot we've seen in similar
 * apps.
 */
export const CONTROL_TICK_MS = 50;

/**
 * Don't send a fresh `setHeadRpyDeg` if the integrated state has
 * moved less than this since the last command. Prevents the
 * controller from spamming identical commands while the joystick
 * is held in the deadzone (after deadzone gating, integration is
 * exactly zero).
 */
export const TARGET_DELTA_THRESHOLD_DEG = 0.3;

/**
 * Smooth recenter duration when the controller is unmounted (e.g.
 * the user navigates away from the Robot tab). The hook spawns a
 * fire-and-forget rAF loop that interpolates from the last
 * commanded yaw/pitch back to (0, 0) over this window, with an
 * ease-out cubic.
 *
 * Kept short enough that the conversation pipeline (head wobbler)
 * resuming on the conv tab won't visibly fight a still-running
 * recenter, and long enough that the head doesn't snap back
 * jarringly.
 */
export const RECENTER_DURATION_MS = 600;

/**
 * Frames per second of the recenter rAF loop. Independent from
 * `CONTROL_TICK_MS` because the recenter runs out-of-band of the
 * setInterval-based control loop (which has been disposed by the
 * time the recenter starts).
 */
export const RECENTER_FRAMES_PER_SEC = 30;

/**
 * Visual joystick dimensions. Sized for thumb-friendly drag on
 * mobile (44 px is the iOS HIG minimum target; we go larger because
 * this is the primary control of the screen).
 */
export const JOYSTICK_RING_DIAMETER_PX = 96;
export const JOYSTICK_THUMB_DIAMETER_PX = 32;
