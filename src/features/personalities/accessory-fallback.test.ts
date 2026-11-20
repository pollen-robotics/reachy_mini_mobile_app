import { beforeEach, describe, expect, it } from 'vitest';

import {
  getActivePersonalityId,
  getPersonalityBeforeAccessory,
  setActivePersonality,
  setActivePersonalityForAccessory,
  setPersonalityBeforeAccessory,
} from './store';

beforeEach(() => {
  setActivePersonality('builtin:default');
});

describe('the personality to go back to after an accessory', () => {
  it('is left alone by a switch an accessory makes', () => {
    setPersonalityBeforeAccessory('builtin:default');
    setActivePersonalityForAccessory('builtin:noir_detective');
    expect(getActivePersonalityId()).toBe('builtin:noir_detective');
    expect(getPersonalityBeforeAccessory()).toBe('builtin:default');
  });

  it('is replaced by a personality picked by hand, which becomes the default', () => {
    setPersonalityBeforeAccessory('builtin:default');
    setActivePersonalityForAccessory('builtin:noir_detective');
    setActivePersonality('builtin:mars_rover');
    expect(getPersonalityBeforeAccessory()).toBeNull();
  });

  it('ignores an id the phone does not know', () => {
    setActivePersonalityForAccessory('builtin:no_such_personality');
    expect(getActivePersonalityId()).toBe('builtin:default');
  });
});
