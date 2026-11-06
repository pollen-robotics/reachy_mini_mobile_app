/**
 * The setup wizard's "update before sign-in" step.
 *
 * Pins the timeline seen on a 1.8.x robot: BLE reports install progress, then
 * the daemon restarts (job forgotten, BLE service restarted) and only the HTTP
 * version read tells us the update landed.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  RobotUpdateFailedError,
  RobotUpdateUnconfirmedError,
  UPDATE_TIMEOUT_MS,
  type RobotUpdateDeps,
  updateRobot,
} from './robotUpdate';
import type { UpdateInfo } from './updateProtocol';
import { updateLanded } from '@/features/daemon-update/latestRelease';

function deps(overrides: Partial<RobotUpdateDeps> = {}): RobotUpdateDeps & { clock: { t: number } } {
  const clock = { t: 0 };
  return {
    clock,
    reauthenticate: vi.fn(async () => true),
    check: vi.fn(async () => ({ available: true, current: '1.8.2', latest: '1.13.0' })),
    start: vi.fn(async () => 'job-1'),
    info: vi.fn(async (): Promise<UpdateInfo> => ({ status: 'in_progress', lines: 1, last: 'Installing' })),
    readVersion: vi.fn(async () => '1.8.2'),
    isBleConnected: vi.fn(() => true),
    isCancelled: vi.fn(() => false),
    onProgress: vi.fn(),
    sleep: vi.fn(async (ms: number) => {
      clock.t += ms;
    }),
    now: () => clock.t,
    ...overrides,
  };
}

describe('updateLanded', () => {
  it('compares against the announced version', () => {
    expect(updateLanded('1.13.0', '1.8.2', '1.13.0')).toBe(true);
    expect(updateLanded('1.8.2', '1.8.2', '1.13.0')).toBe(false);
  });

  it('falls back to "moved past the old version"', () => {
    expect(updateLanded('1.13.0', '1.8.2', null)).toBe(true);
    expect(updateLanded('1.8.2', '1.8.2', null)).toBe(false);
    expect(updateLanded(null, '1.8.2', '1.13.0')).toBe(false);
  });
});

describe('updateRobot', () => {
  it('does nothing when the robot is up to date', async () => {
    const d = deps({ check: vi.fn(async () => ({ available: false, current: '1.13.0', latest: '1.13.0' })) });
    await expect(updateRobot(d)).resolves.toEqual({ kind: 'up-to-date', version: '1.13.0' });
    expect(d.start).not.toHaveBeenCalled();
  });

  it('skips without blocking setup when the check fails', async () => {
    const d = deps({ check: vi.fn(async () => Promise.reject(new Error('ERROR: Check failed'))) });
    await expect(updateRobot(d)).resolves.toMatchObject({ kind: 'skipped' });
    expect(d.start).not.toHaveBeenCalled();
  });

  it('skips when the PIN session cannot be reopened', async () => {
    const d = deps({ reauthenticate: vi.fn(async () => false) });
    await expect(updateRobot(d)).resolves.toMatchObject({ kind: 'skipped', reason: 'pin' });
  });

  it('follows the install over BLE, then confirms the restart over HTTP', async () => {
    const versions = ['1.8.2', '1.8.2', null, null, '1.13.0'];
    const infos: Array<UpdateInfo | Error> = [
      { status: 'in_progress', lines: 3, last: 'Downloading reachy-mini' },
      { status: 'in_progress', lines: 9, last: 'Installed 4 packages' },
      new Error('ERROR: Daemon unreachable'),
    ];
    const d = deps({
      readVersion: vi.fn(async () => (versions.length ? versions.shift()! : '1.13.0')),
      info: vi.fn(async () => {
        const next = infos.shift();
        if (next instanceof Error) throw next;
        return next ?? { status: 'in_progress', lines: 0, last: '' };
      }),
    });

    await expect(updateRobot(d)).resolves.toEqual({ kind: 'updated', version: '1.13.0' });
    const stages = vi.mocked(d.onProgress).mock.calls.map(([p]) => p.stage);
    expect(stages).toEqual(['installing', 'restarting']);
    expect(d.info).toHaveBeenCalledTimes(3);
  });

  it('treats a BLE drop as the restart, not a failure', async () => {
    let connected = true;
    const versions = ['1.8.2', null, '1.13.0'];
    const d = deps({
      readVersion: vi.fn(async () => (versions.length ? versions.shift()! : '1.13.0')),
      isBleConnected: vi.fn(() => connected),
      info: vi.fn(async () => {
        connected = false;
        return { status: 'in_progress', lines: 1, last: 'Installing' } as UpdateInfo;
      }),
    });
    await expect(updateRobot(d)).resolves.toEqual({ kind: 'updated', version: '1.13.0' });
    expect(d.info).toHaveBeenCalledTimes(1);
  });

  it('surfaces a job the daemon reports as failed', async () => {
    const d = deps({ info: vi.fn(async () => ({ status: 'failed', lines: 5, last: 'No space left on device' })) });
    await expect(updateRobot(d)).rejects.toThrow(RobotUpdateFailedError);
    await expect(updateRobot(deps({ info: d.info }))).rejects.toThrow('No space left on device');
  });

  it('gives up when the robot never comes back on the new version', async () => {
    const d = deps({ readVersion: vi.fn(async () => null), isBleConnected: vi.fn(() => false) });
    await expect(updateRobot(d)).rejects.toThrow(RobotUpdateUnconfirmedError);
    expect(d.clock.t).toBeGreaterThan(UPDATE_TIMEOUT_MS);
  });

  it('stops quietly when the flow is cancelled', async () => {
    let cancelled = false;
    const d = deps({
      isCancelled: vi.fn(() => cancelled),
      sleep: vi.fn(async () => {
        cancelled = true;
      }),
    });
    await expect(updateRobot(d)).resolves.toBeNull();
  });
});
