import { describe, expect, it } from 'vitest';

import { isReplacedByNativeSurface } from './nativeReplacements';

describe('isReplacedByNativeSurface', () => {
  it('matches the telepresence Space, whatever the case', () => {
    expect(isReplacedByNativeSurface('pollen-robotics/telepresence')).toBe(true);
    expect(isReplacedByNativeSurface('Pollen-Robotics/Telepresence')).toBe(true);
  });

  it('keeps every other app, forks included', () => {
    expect(isReplacedByNativeSurface('pollen-robotics/emotions')).toBe(false);
    expect(isReplacedByNativeSurface('someone/telepresence')).toBe(false);
  });
});
