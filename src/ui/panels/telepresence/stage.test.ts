import { describe, expect, it } from 'vitest';

import { screenToStageDelta } from './stage';

describe('screenToStageDelta', () => {
  it('passes deltas through when the stage is not rotated', () => {
    expect(screenToStageDelta(3, -4, 0)).toEqual({ x: 3, y: -4 });
  });

  // Stage rotated a quarter turn clockwise: its right is the screen's
  // down, its up is the screen's right.
  it('maps a finger moving down the screen to the stage right', () => {
    expect(screenToStageDelta(0, 10, 90)).toEqual({ x: 10, y: -0 });
  });

  it('maps a finger moving right on the screen to the stage up', () => {
    expect(screenToStageDelta(10, 0, 90)).toEqual({ x: 0, y: -10 });
  });
});
