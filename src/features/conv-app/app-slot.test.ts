import { describe, expect, it, vi } from 'vitest';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { CONV_APP_NAME } from './client';
import { waitForConvAppExit } from './app-slot';

/** A robot whose `apps.status` answers the given states in order, then the last one. */
function robotAnswering(...states: Array<string | null>) {
  let i = 0;
  const rpcCall = vi.fn(async () => {
    const state = states[Math.min(i++, states.length - 1)];
    return state === null ? null : { state, info: { name: CONV_APP_NAME } };
  });
  return { robot: { rpcCall } as unknown as ReachyMiniInstance, rpcCall };
}

describe('waitForConvAppExit', () => {
  it('returns at once when nothing runs', async () => {
    const { robot, rpcCall } = robotAnswering(null);
    await waitForConvAppExit(robot, 1_000, 1);
    expect(rpcCall).toHaveBeenCalledTimes(1);
  });

  it('waits through starting and stopping until the app is gone', async () => {
    const { robot, rpcCall } = robotAnswering('starting', 'stopping', 'stopping', 'stopped');
    await waitForConvAppExit(robot, 1_000, 1);
    expect(rpcCall).toHaveBeenCalledTimes(4);
  });

  it('gives up after the timeout', async () => {
    const { robot } = robotAnswering('stopping');
    const t0 = Date.now();
    await waitForConvAppExit(robot, 30, 5);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('does not wait on another app', async () => {
    const rpcCall = vi.fn(async () => ({ state: 'running', info: { name: 'reachy_mini_clock' } }));
    await waitForConvAppExit({ rpcCall } as unknown as ReachyMiniInstance, 1_000, 1);
    expect(rpcCall).toHaveBeenCalledTimes(1);
  });

  it('treats an unreadable status as gone', async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error('closed');
    });
    await waitForConvAppExit({ rpcCall } as unknown as ReachyMiniInstance, 1_000, 1);
    expect(rpcCall).toHaveBeenCalledTimes(1);
  });
});
