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
 * Soft clamps applied to the integrated yaw / pitch / body-yaw
 * state. The daemon also clamps to its own physical limits, but
 * doing it here means the visual feedback of the joystick reflects
 * "I'm at the edge" instead of silently sending unreachable targets.
 *
 * Pitch + body-yaw values aligned with the desktop app's controller
 * tab (`reachy_mini_desktop_app/src/utils/inputConstants.ts ::
 *  ROBOT_POSITION_RANGES`) since those have been driving real
 * hardware since v0:
 *
 *   - head pitch : ±0.8 rad → ±45.84°
 *   - body yaw   : ±(160° in rad) → ±160°
 *
 * Head yaw deliberately uses a TIGHTER limit (±60°) than the desktop's
 * ±68.75°. Reason: in this hook the head-yaw clamp is the head-yaw
 * RELATIVE to the base (we use tank-style command composition - see
 * useHeadVelocityControl.ts header), and the daemon's safe-IK enforces
 * `|head_yaw_world - body_yaw| ≤ 65°` when `automatic_body_yaw` is
 * enabled (its default). Keeping the relative clamp at 60° leaves a
 * comfortable 5° margin, so the IK never has to silently rewrite our
 * body_yaw target near the edge of the range.
 *
 * Pitch bounds reflect the robot-frame sign convention documented
 * above (`pitch > 0` = chin down). `MAX` is the most-negative value
 * we'll send (chin fully up), `MIN` is the most-positive value
 * (chin fully down). Names use raw signed-bound semantics rather
 * than UP/DOWN labels, which would just push the convention
 * confusion one level deeper.
 */
export const HEAD_YAW_LIMIT_DEG = 60; // relative to base, safe under daemon's 65° IK clamp
export const HEAD_PITCH_MAX_DEG = 45.84; // 0.8 rad
export const HEAD_PITCH_MIN_DEG = -45.84; // -0.8 rad

/**
 * Soft clamp on the integrated body yaw. The robot's analytical
 * kinematics caps `max_body_yaw` at 160° mechanically, but we cap
 * tighter HERE because of an `atan2` quirk in the daemon's matrix
 * decode path:
 *
 * In tank-style mode we send `head_yaw_world = headYawRel + bodyYaw`
 * as one of the RPY components of a rotation matrix. The daemon
 * recovers the yaw from that matrix with `atan2`, which by
 * definition only returns angles in `[-π, +π]` (i.e. ±180°). So if
 * we ever command `|head_yaw_world| > 180°`, the daemon decodes a
 * yaw that's wrapped by ±360° relative to what we sent. Its safe-IK
 * pass then compares this wrapped yaw to `bodyYaw` for the relative-
 * twist check; the brute subtraction sees a ±300° delta where the
 * geometric relative is actually ±60°, exceeds the 65° clamp, and
 * silently rewrites our `body_yaw` to a value far from what we
 * asked - which the user perceives as the base flipping to the
 * opposite side just before it hits the requested extreme.
 *
 * Cap: `HEAD_YAW_LIMIT_DEG + BODY_YAW_LIMIT_DEG ≤ 180°` (with a
 * 5° margin for safety). With `HEAD_YAW_LIMIT_DEG = 60°` this gives
 * `BODY_YAW_LIMIT_DEG ≤ 115°`. The combined head + body reach in
 * each direction stays at ±175°, plenty for full room scanning,
 * and the `atan2` wrap is impossible to hit by construction.
 *
 * If we ever want to push the base past ±115° we'll need to either
 * shrink `HEAD_YAW_LIMIT_DEG` further, or send the head pose as a
 * raw 4×4 matrix via `setTarget` and have the daemon use the matrix
 * directly (without an intermediate `atan2` decode) for the safe-IK
 * comparison. Neither is needed for the joystick UX today.
 */
export const BODY_YAW_LIMIT_DEG = 115;

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
 * Maximum body-yaw angular velocity at full joystick deflection
 * (after the quadratic curve), applied only once the head yaw has
 * saturated and the user is still pushing in the same direction.
 *
 * Tuned slower than the head (60 °/s) because:
 *   - the base carries the whole robot, so a too-aggressive slew
 *     looks twitchy and amplifies any video latency in the user's
 *     feedback loop;
 *   - the perceptual scan rate is gated by the camera feed framing,
 *     not by raw angular velocity - a calmer sweep reads as
 *     "the robot is scanning" rather than "the robot is panicking".
 *
 * 50 °/s sweeps the ±115° range in ~4.6 s of held maximum push,
 * which matches the natural "look around the room" cadence of a
 * human head turn.
 */
export const MAX_BODY_YAW_DEG_PER_SEC = 50;

/**
 * Hysteresis margin used to decide whether the head yaw is "saturated"
 * and ready to spill demand into the body yaw. We compare against
 * `HEAD_YAW_LIMIT_DEG - HEAD_YAW_SATURATION_MARGIN_DEG` so the
 * body starts engaging just before the head reaches its hard edge,
 * which hides the per-axis clamp behind a smooth visual transition
 * (no perceptible "head stops then base starts" gap).
 */
export const HEAD_YAW_SATURATION_MARGIN_DEG = 0.5;

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
