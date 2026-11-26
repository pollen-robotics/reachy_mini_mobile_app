import { beforeEach, describe, expect, it } from 'vitest';

import type { CentralRobotEntry } from './fetchRobotsFromCentral';
import {
  forgetRobot,
  getKnownRobots,
  rememberRobots,
  resetKnownRobotsForTests,
} from './knownRobots';

function entry(hardwareId: string | undefined, name: string): CentralRobotEntry {
  return {
    peerId: `peer-${name}`,
    meta: { name, hardware_id: hardwareId, transport: 'wifi' },
  } as CentralRobotEntry;
}

beforeEach(() => {
  resetKnownRobotsForTests();
});

describe('known robots', () => {
  it('remembers what central lists, per account', () => {
    rememberRobots('alice', [entry('hw-1', 'Reachy')], 1_000);
    expect(getKnownRobots('alice')).toEqual([
      { hardwareId: 'hw-1', name: 'Reachy', transport: 'wifi', lastSeen: 1_000 },
    ]);
    expect(getKnownRobots('bob')).toEqual([]);
    expect(getKnownRobots(null)).toEqual([]);
  });

  it('skips entries without a hardware id', () => {
    rememberRobots('alice', [entry(undefined, 'Old daemon')], 1_000);
    expect(getKnownRobots('alice')).toEqual([]);
  });

  it('keeps a robot once central stops listing it', () => {
    rememberRobots('alice', [entry('hw-1', 'Reachy')], 1_000);
    rememberRobots('alice', [], 500_000);
    expect(getKnownRobots('alice').map(r => r.hardwareId)).toEqual(['hw-1']);
  });

  it('follows a rename and lists the most recently seen first', () => {
    rememberRobots('alice', [entry('hw-1', 'Reachy'), entry('hw-2', 'Mini')], 1_000);
    rememberRobots('alice', [entry('hw-1', 'Kitchen Reachy')], 2_000);
    expect(getKnownRobots('alice').map(r => [r.hardwareId, r.name])).toEqual([
      ['hw-1', 'Kitchen Reachy'],
      ['hw-2', 'Mini'],
    ]);
  });

  it('does not rewrite a fresh sighting', () => {
    rememberRobots('alice', [entry('hw-1', 'Reachy')], 1_000);
    const before = getKnownRobots('alice');
    rememberRobots('alice', [entry('hw-1', 'Reachy')], 30_000);
    expect(getKnownRobots('alice')).toBe(before);
    rememberRobots('alice', [entry('hw-1', 'Reachy')], 120_000);
    expect(getKnownRobots('alice')[0].lastSeen).toBe(120_000);
  });

  it('forgets a robot', () => {
    rememberRobots('alice', [entry('hw-1', 'Reachy'), entry('hw-2', 'Mini')], 1_000);
    forgetRobot('alice', 'hw-1');
    expect(getKnownRobots('alice').map(r => r.hardwareId)).toEqual(['hw-2']);
  });
});
