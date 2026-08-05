import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { resolveRecoveryTarget, waitForRecoveryTarget } from './recovery-target';
import type { RobotInfo } from './sdk-types';

const robot = (id: string, name?: string): RobotInfo =>
  name ? { id, meta: { name } } : { id };

describe('resolveRecoveryTarget', () => {
  it('prefers the exact peer id when still listed', () => {
    const known = [robot('a', 'Reachy'), robot('b', 'Other')];
    expect(resolveRecoveryTarget(known, 'a', 'Reachy')).toBe('a');
  });

  it('remaps by name when the original id is gone (daemon restart)', () => {
    // The daemon re-registered on central under a fresh peer id.
    const known = [robot('fresh-id', 'Reachy')];
    expect(resolveRecoveryTarget(known, 'stale-id', 'Reachy')).toBe('fresh-id');
  });

  it('returns null when neither id nor name matches', () => {
    const known = [robot('x', 'Someone else')];
    expect(resolveRecoveryTarget(known, 'stale-id', 'Reachy')).toBeNull();
  });

  it('does not remap by name when no name is provided', () => {
    const known = [robot('fresh-id', 'Reachy')];
    expect(resolveRecoveryTarget(known, 'stale-id', null)).toBeNull();
    expect(resolveRecoveryTarget(known, 'stale-id')).toBeNull();
  });

  it('ignores listings without a name during name matching', () => {
    const known = [robot('anon'), robot('named', 'Reachy')];
    expect(resolveRecoveryTarget(known, 'stale-id', 'Reachy')).toBe('named');
  });
});

describe('waitForRecoveryTarget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when the target is already listed', async () => {
    const target = await waitForRecoveryTarget({
      getKnownRobots: () => [robot('a', 'Reachy')],
      robotId: 'a',
    });
    expect(target).toBe('a');
  });

  it('polls until the rebooted robot re-registers under a new id', async () => {
    let known: RobotInfo[] = [];
    const promise = waitForRecoveryTarget({
      getKnownRobots: () => known,
      robotId: 'stale-id',
      robotName: 'Reachy',
      pollMs: 500,
    });
    // Robot comes back after ~2 s of "rebooting".
    await vi.advanceTimersByTimeAsync(2000);
    known = [robot('fresh-id', 'Reachy')];
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBe('fresh-id');
  });

  it('gives up after the timeout when the robot never comes back', async () => {
    const promise = waitForRecoveryTarget({
      getKnownRobots: () => [],
      robotId: 'stale-id',
      robotName: 'Reachy',
      timeoutMs: 3000,
      pollMs: 500,
    });
    await vi.advanceTimersByTimeAsync(3500);
    await expect(promise).resolves.toBeNull();
  });

  it('bails out on cancellation without waiting for the timeout', async () => {
    let cancelled = false;
    const promise = waitForRecoveryTarget({
      getKnownRobots: () => [],
      robotId: 'stale-id',
      timeoutMs: 60_000,
      pollMs: 500,
      isCancelled: () => cancelled,
    });
    await vi.advanceTimersByTimeAsync(1000);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBeNull();
  });
});
