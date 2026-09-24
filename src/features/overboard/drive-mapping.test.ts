import { describe, expect, it } from 'vitest';

import { deflectionToDrive, isStop } from './drive-mapping';

describe('deflectionToDrive', () => {
  it('maps stick up to forward and stick left to a left turn', () => {
    expect(deflectionToDrive(0, -1)).toEqual({ linear: 1, angular: 0 });
    expect(deflectionToDrive(-1, 0)).toEqual({ linear: 0, angular: 1 });
    expect(deflectionToDrive(1, 1)).toEqual({ linear: -1, angular: -1 });
  });

  it('applies a quadratic curve and clamps', () => {
    expect(deflectionToDrive(0, -0.5).linear).toBeCloseTo(0.25);
    expect(deflectionToDrive(0, -2).linear).toBe(1);
  });

  it('never yields negative zero', () => {
    const d = deflectionToDrive(0, 0);
    expect(Object.is(d.linear, -0)).toBe(false);
    expect(isStop(d)).toBe(true);
  });
});
