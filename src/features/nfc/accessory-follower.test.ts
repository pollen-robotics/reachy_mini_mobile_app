import { describe, expect, it } from 'vitest';

import {
  IDLE_FOLLOWER,
  followAccessory,
  type FollowerContext,
  type FollowerState,
} from './accessory-follower';
import type { AccessoryView } from './accessory';

const none: AccessoryView = { state: 'none', personality: null };
const blank: AccessoryView = { state: 'blank', personality: null };
const unknown: AccessoryView = { state: 'unknown', personality: null };
const noReader: AccessoryView = { state: 'unavailable', personality: null };
const hat = (personality: string): AccessoryView => ({ state: 'known', personality });

const ctx = (active: string, fallback: string | null = null): FollowerContext => ({
  active,
  fallback,
});
const launched = (current: string | null = null): FollowerState => ({ launched: true, current });

describe('followAccessory, at launch', () => {
  it('starts as the personality of an accessory already on the reader', () => {
    expect(followAccessory(null, hat('noir_detective'), IDLE_FOLLOWER, ctx('default'))).toEqual({
      state: launched('noir_detective'),
      fallback: 'default',
      switchTo: 'noir_detective',
    });
  });

  it('starts as the default once an accessory came off while the app was closed', () => {
    for (const reading of [none, blank, unknown]) {
      expect(
        followAccessory(null, reading, IDLE_FOLLOWER, ctx('noir_detective', 'default'))
      ).toEqual({ state: launched(), fallback: null, switchTo: 'default' });
    }
  });

  it('keeps the running personality with no accessory and nothing to go back to', () => {
    expect(followAccessory(null, none, IDLE_FOLLOWER, ctx('default'))).toEqual({
      state: launched(),
      fallback: null,
      switchTo: null,
    });
  });

  it('waits for the reader before counting a reading as the launch', () => {
    const step = followAccessory(null, noReader, IDLE_FOLLOWER, ctx('noir_detective', 'default'));
    expect(step).toEqual({ state: IDLE_FOLLOWER, fallback: 'default', switchTo: null });
  });
});

describe('followAccessory, once launched', () => {
  it('switches to the personality of an accessory put on the reader', () => {
    expect(followAccessory(none, hat('noir_detective'), launched(), ctx('default'))).toEqual({
      state: launched('noir_detective'),
      fallback: 'default',
      switchTo: 'noir_detective',
    });
  });

  it('goes back to the default once the accessory is off', () => {
    expect(
      followAccessory(
        hat('noir_detective'),
        none,
        launched('noir_detective'),
        ctx('noir_detective', 'default')
      )
    ).toEqual({ state: launched(), fallback: null, switchTo: 'default' });
  });

  it('keeps the personality from before the first of two swapped accessories', () => {
    const step = followAccessory(
      hat('noir_detective'),
      hat('mars_rover'),
      launched('noir_detective'),
      ctx('noir_detective', 'default')
    );
    expect(step).toEqual({
      state: launched('mars_rover'),
      fallback: 'default',
      switchTo: 'mars_rover',
    });
  });

  it('keeps the running personality for a blank or unrecognised accessory', () => {
    for (const reading of [blank, unknown]) {
      expect(followAccessory(none, reading, launched(), ctx('default')).switchTo).toBeNull();
    }
    expect(
      followAccessory(
        hat('noir_detective'),
        blank,
        launched('noir_detective'),
        ctx('noir_detective', 'default')
      ).switchTo
    ).toBeNull();
  });

  it('leaves a personality picked by hand while the accessory was on', () => {
    expect(
      followAccessory(hat('noir_detective'), none, launched('noir_detective'), ctx('mars_rover'))
    ).toEqual({ state: launched(), fallback: null, switchTo: null });
  });

  it('does not switch for an accessory carrying the personality it already put on', () => {
    expect(
      followAccessory(
        blank,
        hat('noir_detective'),
        launched('noir_detective'),
        ctx('noir_detective', 'default')
      ).switchTo
    ).toBeNull();
  });

  it('records an accessory carrying the running personality, to revert from it', () => {
    const on = followAccessory(none, hat('default'), launched(), ctx('default'));
    expect(on).toEqual({ state: launched('default'), fallback: null, switchTo: null });
    expect(followAccessory(hat('default'), none, on.state, ctx('default')).switchTo).toBeNull();
  });

  it('does nothing for an empty reader with no accessory to revert from', () => {
    expect(followAccessory(blank, none, launched(), ctx('default')).switchTo).toBeNull();
  });
});

describe('followAccessory, with the reader dropping out', () => {
  it('does nothing when the reader goes away', () => {
    const state = launched('noir_detective');
    expect(followAccessory(hat('noir_detective'), noReader, state, ctx('x', 'default'))).toEqual({
      state,
      fallback: 'default',
      switchTo: null,
    });
  });

  it('does not compare the first reading once it is back', () => {
    const state = launched('noir_detective');
    const c = ctx('noir_detective', 'default');
    expect(followAccessory(null, hat('noir_detective'), state, c)).toEqual({
      state,
      fallback: 'default',
      switchTo: null,
    });
    expect(followAccessory(null, none, state, c).switchTo).toBeNull();
  });

  it('keeps the default through a reading lost while the accessory is on', () => {
    const c = ctx('noir_detective', 'default');
    let state = launched('noir_detective');
    let previous: AccessoryView | null = hat('noir_detective');
    for (const reading of [noReader, hat('noir_detective'), none]) {
      const step = followAccessory(previous, reading, state, c);
      if (reading !== none) expect(step.switchTo).toBeNull();
      else expect(step.switchTo).toBe('default');
      state = step.state;
      previous = reading.state === 'unavailable' ? null : reading;
    }
  });
});
