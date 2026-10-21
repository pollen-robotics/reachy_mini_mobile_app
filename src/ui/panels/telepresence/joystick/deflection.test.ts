/**
 * Tests for the pure joystick math (clamp-to-circle + radial deadzone
 * rescale). Pins the sign convention (+y = down) and the "ramp from
 * zero just past the deadzone" behaviour both input sources rely on.
 */
import { describe, expect, it } from 'vitest';

import { applyRadialDeadzone, computeDeflection } from './deflection';

describe('computeDeflection', () => {
  it('returns zero at the centre', () => {
    expect(computeDeflection(0, 0, 60, 0.1)).toEqual({ x: 0, y: 0 });
  });

  it('returns zero inside the deadzone', () => {
    // 5 px on a 60 px radius = 0.083 < 0.1
    expect(computeDeflection(5, 0, 60, 0.1)).toEqual({ x: 0, y: 0 });
    expect(computeDeflection(-3, 4, 60, 0.1)).toEqual({ x: 0, y: 0 });
  });

  it('keeps screen convention: +x right, +y down', () => {
    const right = computeDeflection(60, 0, 60, 0);
    expect(right.x).toBeCloseTo(1);
    expect(right.y).toBeCloseTo(0);

    const down = computeDeflection(0, 60, 60, 0);
    expect(down.x).toBeCloseTo(0);
    expect(down.y).toBeCloseTo(1);

    const upLeft = computeDeflection(-30, -30, 60, 0);
    expect(upLeft.x).toBeLessThan(0);
    expect(upLeft.y).toBeLessThan(0);
  });

  it('clamps to the unit circle when dragged past the ring', () => {
    const d = computeDeflection(300, 400, 60, 0.1);
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1);
    // Direction preserved (3:4:5 triangle).
    expect(d.x).toBeCloseTo(0.6);
    expect(d.y).toBeCloseTo(0.8);
  });

  it('rescales the band past the deadzone to [0, 1]', () => {
    // Half-way between deadzone (0.1) and edge (1) → 0.5.
    const d = computeDeflection(0.55 * 60, 0, 60, 0.1);
    expect(d.x).toBeCloseTo(0.5);
    expect(d.y).toBeCloseTo(0);
  });

  it('ramps continuously from zero at the deadzone boundary', () => {
    const d = computeDeflection(0.1 * 60 + 1e-6, 0, 60, 0.1);
    expect(d.x).toBeGreaterThanOrEqual(0);
    expect(d.x).toBeLessThan(1e-4);
  });

  it('is zero for a degenerate radius', () => {
    expect(computeDeflection(10, 10, 0, 0.1)).toEqual({ x: 0, y: 0 });
    expect(computeDeflection(10, 10, -5, 0.1)).toEqual({ x: 0, y: 0 });
  });

  it('with no deadzone is a plain normalise + clamp', () => {
    const d = computeDeflection(30, 0, 60, 0);
    expect(d.x).toBeCloseTo(0.5);
  });
});

describe('applyRadialDeadzone', () => {
  it('rejects everything when the deadzone covers the whole disk', () => {
    expect(applyRadialDeadzone(1, 0, 1)).toEqual({ x: 0, y: 0 });
  });

  it('clamps over-unit diagonal stick readings', () => {
    const d = applyRadialDeadzone(1, 1, 0.15);
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1);
    expect(d.x).toBeCloseTo(d.y);
  });

  it('returns zero on non-finite input', () => {
    expect(applyRadialDeadzone(Number.NaN, 0, 0.1)).toEqual({ x: 0, y: 0 });
  });
});
