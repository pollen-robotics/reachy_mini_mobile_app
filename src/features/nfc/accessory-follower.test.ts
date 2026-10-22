import { describe, expect, it } from 'vitest';

import { IDLE_FOLLOWER, followAccessory } from './accessory-follower';
import type { AccessoryView } from './accessory';

const none: AccessoryView = { state: 'none', personality: null };
const blank: AccessoryView = { state: 'blank', personality: null };
const hat = (personality: string): AccessoryView => ({ state: 'known', personality });

describe('followAccessory', () => {
  it('switches to the personality of an accessory put on the reader', () => {
    const step = followAccessory(
      none,
      hat('noir_detective'),
      IDLE_FOLLOWER,
      'default',
      'builtin:default'
    );
    expect(step.action).toEqual({ kind: 'apply', personality: 'noir_detective' });
    expect(step.state).toEqual({
      accessoryPersonality: 'noir_detective',
      restoreTo: 'builtin:default',
    });
  });

  it('starts with an accessory already on the reader', () => {
    expect(
      followAccessory(null, hat('noir_detective'), IDLE_FOLLOWER, 'default', 'default').action
    ).toEqual({
      kind: 'apply',
      personality: 'noir_detective',
    });
  });

  it('goes back to the personality from before the accessory once it is off', () => {
    const on = followAccessory(
      none,
      hat('noir_detective'),
      IDLE_FOLLOWER,
      'default',
      'default'
    ).state;
    const off = followAccessory(
      hat('noir_detective'),
      none,
      on,
      'noir_detective',
      'noir_detective'
    );
    expect(off.action).toEqual({ kind: 'restore', activeId: 'default' });
    expect(off.state).toEqual(IDLE_FOLLOWER);
  });

  it('keeps the personality from before the first of two swapped accessories', () => {
    const first = followAccessory(
      none,
      hat('noir_detective'),
      IDLE_FOLLOWER,
      'default',
      'default'
    ).state;
    const second = followAccessory(
      hat('noir_detective'),
      hat('mars_rover'),
      first,
      'noir_detective',
      'noir_detective'
    );
    expect(second.action).toEqual({ kind: 'apply', personality: 'mars_rover' });
    expect(second.state.restoreTo).toBe('default');
  });

  it('keeps the running personality for a blank or unrecognised accessory', () => {
    expect(followAccessory(none, blank, IDLE_FOLLOWER, 'default', 'default')).toEqual({
      state: IDLE_FOLLOWER,
      action: null,
    });
    expect(
      followAccessory(
        none,
        { state: 'unknown', personality: null },
        IDLE_FOLLOWER,
        'default',
        'default'
      ).action
    ).toBeNull();
  });

  it('leaves a personality picked by hand while the accessory was on', () => {
    const on = followAccessory(
      none,
      hat('noir_detective'),
      IDLE_FOLLOWER,
      'default',
      'default'
    ).state;
    expect(
      followAccessory(hat('noir_detective'), none, on, 'mars_rover', 'mars_rover').action
    ).toBeNull();
  });

  it('forgets what an accessory taken off while the app was closed left behind', () => {
    const left = { accessoryPersonality: null, restoreTo: 'default' };
    expect(followAccessory(null, none, left, 'default', 'default').state).toEqual(IDLE_FOLLOWER);
    const unanswered = { state: 'unavailable' as const, personality: null };
    expect(followAccessory(unanswered, none, left, 'default', 'default').state).toEqual(
      IDLE_FOLLOWER
    );
    // ...but an accessory still on keeps it as the personality to go back to.
    expect(
      followAccessory(null, hat('noir_detective'), left, 'noir_detective', 'noir_detective').state
    ).toEqual({
      accessoryPersonality: 'noir_detective',
      restoreTo: 'default',
    });
  });

  it('does nothing when the reader goes away, or for an accessory already running', () => {
    const on = followAccessory(
      none,
      hat('noir_detective'),
      IDLE_FOLLOWER,
      'default',
      'default'
    ).state;
    expect(
      followAccessory(
        hat('noir_detective'),
        { state: 'unavailable', personality: null },
        on,
        'noir_detective',
        'x'
      )
    ).toEqual({
      state: on,
      action: null,
    });
    expect(
      followAccessory(none, hat('default'), IDLE_FOLLOWER, 'default', 'default').action
    ).toBeNull();
  });
});
