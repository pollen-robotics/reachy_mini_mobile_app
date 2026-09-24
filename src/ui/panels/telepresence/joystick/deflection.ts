/**
 * Pure joystick math, shared by the touch puck (`useJoystickPointer`)
 * and the game-controller bridge (`useGamepadDeflection`).
 *
 * Both inputs end up as a deflection in the unit disk: +x = right,
 * +y = DOWN (screen / Gamepad-API convention). A radial deadzone is
 * applied and the surviving band is rescaled to [0, 1], so output
 * ramps up from zero just past the deadzone instead of jumping
 * straight to the deadzone value.
 */

export interface Deflection {
  x: number;
  y: number;
}

/** Radial deadzone for the on-screen puck (fraction of the radius). */
export const JOYSTICK_DEADZONE = 0.1;

/**
 * Radial deadzone for a physical stick. Looser than the touch puck's:
 * analog sticks rest with more drift than a finger, so a tighter zone
 * would let a centred stick creep the robot.
 */
export const GAMEPAD_DEADZONE = 0.15;

const ZERO: Readonly<Deflection> = Object.freeze({ x: 0, y: 0 });

/**
 * Apply a radial deadzone to an already-normalised vector. The
 * magnitude is clamped to 1 first (diagonal sticks, or a finger
 * dragged past the ring, read beyond the unit circle), then the
 * `[deadzone, 1]` band is rescaled to `[0, 1]` keeping the direction.
 *
 * Always returns a fresh object; zero is a literal `{0, 0}` (never
 * `-0`) so callers can compare with `=== 0` safely.
 */
export function applyRadialDeadzone(
  x: number,
  y: number,
  deadzone: number,
): Deflection {
  const magnitude = Math.hypot(x, y);
  if (!Number.isFinite(magnitude) || magnitude === 0) return { ...ZERO };
  const dz = Math.max(0, deadzone);
  if (dz >= 1 || magnitude < dz) return { ...ZERO };

  const clamped = Math.min(magnitude, 1);
  const scaled = (clamped - dz) / (1 - dz);
  if (scaled === 0) return { ...ZERO };
  return {
    x: (x / magnitude) * scaled,
    y: (y / magnitude) * scaled,
  };
}

/**
 * Convert a raw pointer offset from the ring centre (px) into a
 * deflection: normalise by the ring radius, clamp to the circle, then
 * apply the radial deadzone.
 */
export function computeDeflection(
  dx: number,
  dy: number,
  radius: number,
  deadzone: number,
): Deflection {
  if (!(radius > 0)) return { ...ZERO };
  return applyRadialDeadzone(dx / radius, dy / radius, deadzone);
}
