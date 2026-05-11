import { describe, expect, test } from 'vitest';

import type { CentralRobotEntry } from './fetchRobotsFromCentral';
import { dropProducer, patchBusyState } from './remoteRobotsReducers';

const ALICE: CentralRobotEntry = {
  id: 'alice-peer-1',
  busy: false,
  activeApp: null,
  meta: { name: 'alice-r' },
};

const BOB: CentralRobotEntry = {
  id: 'bob-peer-1',
  busy: true,
  activeApp: 'Conversation App',
  meta: { name: 'bob-r' },
};

describe('patchBusyState', () => {
  test('flips busy + activeApp on the matching row', () => {
    const out = patchBusyState([ALICE, BOB], 'alice-peer-1', true, 'Hand Tracker');
    expect(out).toHaveLength(2);
    expect(out![0]).toEqual({ ...ALICE, busy: true, activeApp: 'Hand Tracker' });
    expect(out![1]).toBe(BOB);
  });

  test('preserves identity (same array ref) when peerId is unknown', () => {
    const input = [ALICE, BOB];
    const out = patchBusyState(input, 'ghost-peer', true, null);
    expect(out).toBe(input);
  });

  test('passes undefined through when the cache slot is empty', () => {
    expect(patchBusyState(undefined, 'alice-peer-1', true, null)).toBeUndefined();
  });

  test('matches against `peerId` when `id` is absent (legacy wire shape)', () => {
    const legacy: CentralRobotEntry = {
      peerId: 'legacy-peer',
      meta: { name: 'legacy-r' },
    };
    const out = patchBusyState([legacy], 'legacy-peer', true, 'X');
    expect(out![0]).toEqual({ ...legacy, busy: true, activeApp: 'X' });
  });

  test('matches against `peer_id` when neither `id` nor `peerId` is set', () => {
    const legacy: CentralRobotEntry = {
      peer_id: 'snake-peer',
      meta: { name: 'snake-r' },
    };
    const out = patchBusyState([legacy], 'snake-peer', false, null);
    expect(out![0]).toEqual({ ...legacy, busy: false, activeApp: null });
  });

  test('writes activeApp = null when transitioning back to free', () => {
    const out = patchBusyState([BOB], 'bob-peer-1', false, null);
    expect(out![0].busy).toBe(false);
    expect(out![0].activeApp).toBeNull();
  });
});

describe('dropProducer', () => {
  test('removes the matching row, preserving the others', () => {
    const out = dropProducer([ALICE, BOB], 'alice-peer-1');
    expect(out).toHaveLength(1);
    expect(out![0]).toBe(BOB);
  });

  test('preserves identity (same array ref) when peerId is unknown', () => {
    const input = [ALICE, BOB];
    const out = dropProducer(input, 'ghost-peer');
    expect(out).toBe(input);
  });

  test('passes undefined through when the cache slot is empty', () => {
    expect(dropProducer(undefined, 'alice-peer-1')).toBeUndefined();
  });

  test('returns an empty array when the dropped peer was the only one', () => {
    const out = dropProducer([ALICE], 'alice-peer-1');
    expect(out).toEqual([]);
  });
});
