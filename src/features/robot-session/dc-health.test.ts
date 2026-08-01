/**
 * Tests for the data-channel health monitor.
 *
 * The properties that must hold:
 *   - a streak of failed motion sends escalates to `onFatalLink`
 *     exactly once at the threshold; any success resets the streak;
 *   - the visibility-return probe escalates immediately when the
 *     no-op command is refused, and stays quiet when it goes through;
 *   - while suspended (SDK auto re-dial in flight) neither failures
 *     nor probes count — the transport is down by design;
 *   - resuming resets the streak so the OLD transport's failures
 *     don't poison the new one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReachyMiniInstance } from './sdk-types';

import { createDcHealthMonitor, type DcHealthMonitor } from './dc-health';

// Mirrors FAILURE_FATAL_THRESHOLD in dc-health.ts. Deliberately
// duplicated: a silent change to the SDK-facing patience window
// should fail a test, not slip through.
const THRESHOLD = 120;

let onFatalLink: ReturnType<typeof vi.fn>;
let robot: { setAntennasDeg: ReturnType<typeof vi.fn> } | null;
let monitor: DcHealthMonitor;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  onFatalLink = vi.fn();
  robot = { setAntennasDeg: vi.fn().mockReturnValue(true) };
  monitor = createDcHealthMonitor({
    getRobot: () => robot as unknown as ReachyMiniInstance | null,
    onFatalLink,
  });
});

function fail(times: number): void {
  for (let i = 0; i < times; i++) monitor.recordSend(false, 'test');
}

describe('failure streak escalation', () => {
  it('stays quiet below the threshold', () => {
    fail(THRESHOLD - 1);
    expect(onFatalLink).not.toHaveBeenCalled();
  });

  it('escalates at the threshold', () => {
    fail(THRESHOLD);
    expect(onFatalLink).toHaveBeenCalledTimes(1);
    expect(String(onFatalLink.mock.calls[0]![0])).toMatch(/data channel/);
  });

  it('a single success resets the streak', () => {
    fail(THRESHOLD - 1);
    monitor.recordSend(true, 'test');
    fail(THRESHOLD - 1);
    expect(onFatalLink).not.toHaveBeenCalled();
  });

  it('reset() clears the streak for a fresh session', () => {
    fail(THRESHOLD - 1);
    monitor.reset();
    fail(THRESHOLD - 1);
    expect(onFatalLink).not.toHaveBeenCalled();
  });
});

describe('visibility-return probe', () => {
  it('stays quiet when the no-op command is accepted', async () => {
    await monitor.probeRobotLink();
    expect(robot!.setAntennasDeg).toHaveBeenCalledWith(0, 0);
    expect(onFatalLink).not.toHaveBeenCalled();
  });

  it('escalates immediately when the channel refuses the probe', async () => {
    robot!.setAntennasDeg.mockReturnValue(false);
    await monitor.probeRobotLink();
    expect(onFatalLink).toHaveBeenCalledTimes(1);
    expect(String(onFatalLink.mock.calls[0]![0])).toMatch(/hidden/);
  });

  it('is a no-op while the robot ref is null (pre-connect)', async () => {
    robot = null;
    await monitor.probeRobotLink();
    expect(onFatalLink).not.toHaveBeenCalled();
  });
});

describe('suspension (SDK auto re-dial window)', () => {
  it('ignores failures and probes while suspended', async () => {
    monitor.setSuspended(true);
    fail(THRESHOLD * 2);
    robot!.setAntennasDeg.mockReturnValue(false);
    await monitor.probeRobotLink();
    expect(onFatalLink).not.toHaveBeenCalled();
    expect(robot!.setAntennasDeg).not.toHaveBeenCalled();
  });

  it('resume resets the streak accumulated before suspension', () => {
    fail(THRESHOLD - 1);
    monitor.setSuspended(true);
    monitor.setSuspended(false);
    // The new transport starts from zero: one more failure must not
    // tip a counter carried over from the dead one.
    fail(THRESHOLD - 1);
    expect(onFatalLink).not.toHaveBeenCalled();
    fail(1);
    expect(onFatalLink).toHaveBeenCalledTimes(1);
  });

  it('redundant setSuspended calls are no-ops', () => {
    fail(THRESHOLD - 1);
    // Same-value call must not touch the counter.
    monitor.setSuspended(false);
    fail(1);
    expect(onFatalLink).toHaveBeenCalledTimes(1);
  });
});
