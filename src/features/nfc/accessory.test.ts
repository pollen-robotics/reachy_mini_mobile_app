import { describe, expect, it } from 'vitest';

import {
  canLinkAccessory,
  describeAccessory,
  fromTagToken,
  settleTag,
  toTagToken,
  type AccessoryState,
} from './accessory';

const robot = new Set(['default', 'noir_detective', 'user_personalities/my_bot']);

describe('fromTagToken', () => {
  it('reads built-in and user tokens', () => {
    expect(fromTagToken('hf_noir_detective')).toBe('noir_detective');
    expect(fromTagToken(' usr_my_bot ')).toBe('user_personalities/my_bot');
  });

  it('ignores anything else, and empty names', () => {
    expect(fromTagToken('badge42')).toBeNull();
    expect(fromTagToken('hf_')).toBeNull();
    expect(fromTagToken(null)).toBeNull();
  });
});

describe('describeAccessory', () => {
  it('is unavailable without a reader, or with the reader off', () => {
    expect(describeAccessory('unavailable', null, robot).state).toBe('unavailable');
    expect(describeAccessory('disabled', { present: true }, robot).state).toBe('unavailable');
  });

  it('tells an empty reader from a blank accessory', () => {
    expect(describeAccessory('idle', null, robot).state).toBe('none');
    expect(describeAccessory('tag', { present: true, blank: true }, robot).state).toBe('blank');
  });

  it('names the personality only when this robot has it', () => {
    expect(describeAccessory('tag', { present: true, content: 'usr_my_bot' }, robot)).toEqual({
      state: 'known',
      personality: 'user_personalities/my_bot',
    });
    expect(describeAccessory('tag', { present: true, content: 'hf_mars_rover' }, robot).state).toBe(
      'unknown'
    );
    expect(describeAccessory('tag', { present: true, content: 'badge42' }, robot).state).toBe(
      'unknown'
    );
  });
});

describe('settleTag', () => {
  const hat = { present: true, uid: '04A1', readable: true, content: 'hf_noir_detective' };

  it('keeps the last reading while the same tag cannot be read', () => {
    expect(settleTag({ present: true, uid: '04A1', readable: false }, hat)).toBe(hat);
  });

  it('shows no accessory for an unreadable new tag', () => {
    expect(settleTag({ present: true, uid: '04B2', readable: false }, hat)?.present).toBe(false);
    expect(settleTag({ present: true, readable: false }, null)?.present).toBe(false);
  });

  it('passes readable, blank and absent readings through', () => {
    expect(settleTag(hat, null)).toBe(hat);
    const blank = { present: true, readable: false, blank: true };
    expect(settleTag(blank, hat)).toBe(blank);
    expect(settleTag(null, hat)).toBeNull();
  });
});

// Same vectors as the conversation app's tests/test_personality_tag.py.
describe('tag text, shared with the conversation app', () => {
  it.each([
    ['noir_detective', 'hf_noir_detective'],
    ['default', 'hf_default'],
    ['user_personalities/my_bot', 'usr_my_bot'],
  ])('round-trips %s as %s', (selection, token) => {
    expect(toTagToken(selection)).toBe(token);
    expect(fromTagToken(token)).toBe(selection);
  });

  it('never lets a user personality collide with a built-in one', () => {
    const builtin = toTagToken('noir_detective');
    const impostor = toTagToken('user_personalities/hf_noir_detective');
    expect(builtin).not.toBe(impostor);
    expect(fromTagToken(builtin)).toBe('noir_detective');
    expect(fromTagToken(impostor)).toBe('user_personalities/hf_noir_detective');
  });

  it('lets a user reuse a built-in name', () => {
    expect(toTagToken('mars_rover')).not.toBe(toTagToken('user_personalities/mars_rover'));
  });

  it('writes nothing for an empty name', () => {
    expect(toTagToken(' ')).toBeNull();
  });
});

describe('canLinkAccessory', () => {
  it('offers a link for a blank, unknown or other-personality accessory only', () => {
    const view = (state: AccessoryState, personality: string | null = null) => ({
      state,
      personality,
    });
    expect(canLinkAccessory(view('blank'), 'default')).toBe(true);
    expect(canLinkAccessory(view('unknown'), 'default')).toBe(true);
    expect(canLinkAccessory(view('known', 'noir_detective'), 'default')).toBe(true);
    expect(canLinkAccessory(view('known', 'default'), 'default')).toBe(false);
    expect(canLinkAccessory(view('none'), 'default')).toBe(false);
    expect(canLinkAccessory(view('unavailable'), 'default')).toBe(false);
    expect(canLinkAccessory(view('blank'), null)).toBe(false);
  });
});
