/**
 * The session-start budget follows the handshake's progress.
 *
 * With no ICE progress the attempt is stopped at startAttemptTimeoutMs (a
 * silent daemon). Once ICE is `connected` the media path works and the
 * answering, and the attempt gets startAttemptProgressTimeoutMs in total:
 * on a lossy hop the data channel can need several more seconds, and the
 * flat budget killed a session that was nearly ready (seen on device).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startRobotSession } from './start-session';
import type { ReachyMiniInstance } from './sdk-types';
import { SESSION_TIMINGS } from './timings';

function fakeRobot() {
  const target = new EventTarget();
  let resolveStart!: () => void;
  let rejectStart!: (e: Error) => void;
  const robot = Object.assign(target, {
    state: 'connected',
    startSession: vi.fn(
      () =>
        new Promise<void>((res, rej) => {
          resolveStart = res;
          rejectStart = rej;
        }),
    ),
    // The SDK rejects the pending start when it is stopped.
    stopSession: vi.fn(async () => rejectStart(new Error('Session stopped'))),
  });
  const ice = (state: string) =>
    target.dispatchEvent(new CustomEvent('iceStateChange', { detail: { state } }));
  return { robot: robot as unknown as ReachyMiniInstance, raw: robot, ice, resolve: () => resolveStart() };
}

const expectedStop = async (fn: () => Promise<unknown>) => {
  await fn();
};

beforeEach(() => {
  vi.useFakeTimers();
  // Node test environment: the module schedules through `window`.
  vi.stubGlobal('window', globalThis);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('startRobotSession timeout', () => {
  it('stops at the short budget when ICE never moves', async () => {
    const { robot, raw } = fakeRobot();
    const outcome = startRobotSession({ robot, peerId: 'p', expectedStop });

    await vi.advanceTimersByTimeAsync(SESSION_TIMINGS.startAttemptTimeoutMs + 100);

    expect(raw.stopSession).toHaveBeenCalledOnce();
    expect((await outcome).ok).toBe(false);
  });

  it('lets a handshake under way finish past the short budget', async () => {
    const { robot, raw, ice, resolve } = fakeRobot();
    const outcome = startRobotSession({ robot, peerId: 'p', expectedStop });

    await vi.advanceTimersByTimeAsync(1_000);
    ice('checking');
    ice('connected');
    await vi.advanceTimersByTimeAsync(12_000); // past 8 s, data channel still opening
    expect(raw.stopSession).not.toHaveBeenCalled();
    resolve();

    expect(await outcome).toEqual({ ok: true });
  });

  it('keeps the short budget while ICE is only checking', async () => {
    // The robot answered, but the media path may be blackholed.
    const { robot, raw, ice } = fakeRobot();
    const outcome = startRobotSession({ robot, peerId: 'p', expectedStop });

    await vi.advanceTimersByTimeAsync(1_000);
    ice('checking');
    await vi.advanceTimersByTimeAsync(SESSION_TIMINGS.startAttemptTimeoutMs);

    expect(raw.stopSession).toHaveBeenCalledOnce();
    expect((await outcome).ok).toBe(false);
  });

  it('still stops at the long budget when the handshake never completes', async () => {
    const { robot, raw, ice } = fakeRobot();
    const outcome = startRobotSession({ robot, peerId: 'p', expectedStop });

    await vi.advanceTimersByTimeAsync(1_000);
    ice('connected');
    await vi.advanceTimersByTimeAsync(SESSION_TIMINGS.startAttemptProgressTimeoutMs);

    expect(raw.stopSession).toHaveBeenCalledOnce();
    expect((await outcome).ok).toBe(false);
  });

  it('ignores ICE events after the attempt settled', async () => {
    const { robot, raw, ice, resolve } = fakeRobot();
    const outcome = startRobotSession({ robot, peerId: 'p', expectedStop });
    resolve();
    await outcome;

    ice('connected');
    await vi.advanceTimersByTimeAsync(SESSION_TIMINGS.startAttemptProgressTimeoutMs + 100);
    expect(raw.stopSession).not.toHaveBeenCalled();
  });
});
