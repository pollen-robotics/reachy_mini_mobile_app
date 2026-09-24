import type { OverboardDrive } from './types';

/**
 * Joystick deflection (`[-1, 1]^2`, screen convention +y = down) to a
 * drive command. Stick up = forward, stick left = turn left. A quadratic
 * curve on both axes gives fine control around the centre, where a
 * wheeled base is hardest to handle. Values are rounded to 3 decimals to
 * keep the wire messages short and dedupe-friendly.
 */
export function deflectionToDrive(x: number, y: number): OverboardDrive {
  const curve = (v: number) => {
    const c = Math.max(-1, Math.min(1, v));
    return c * Math.abs(c);
  };
  const round = (v: number) => Math.round(v * 1000) / 1000 || 0;
  return { linear: round(curve(-y)), angular: round(curve(-x)) };
}

export function isStop(drive: OverboardDrive): boolean {
  return drive.linear === 0 && drive.angular === 0;
}
