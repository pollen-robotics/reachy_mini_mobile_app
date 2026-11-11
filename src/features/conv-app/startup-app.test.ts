/**
 * The antenna-start controller against a scripted JSON-RPC robot: what hides
 * the switch, what a refused or lost change leaves on screen, and what
 * happens to another app that held the startup slot.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { CONV_APP_NAME } from './client';
import {
  createStartupAppController,
  INITIAL_STARTUP_APP_STATE,
  STARTUP_READ_ATTEMPTS,
  type StartupAppState,
} from './startup-app';

function rpcError(reason: string): Error {
  return Object.assign(new Error(reason), { reason });
}

/** A robot whose startup slot is `startup`; `fail` scripts the next answers. */
function setup(startup: string | null) {
  const robot = { startup, fail: [] as Array<Error | undefined> };
  const rpcCall = vi.fn(async (method: string, params: { name?: string | null } = {}) => {
    const failure = robot.fail.shift();
    if (failure) throw failure;
    if (method === 'apps.set_startup') robot.startup = params.name ?? null;
    return { name: robot.startup };
  });
  let state: StartupAppState = INITIAL_STARTUP_APP_STATE;
  const controller = createStartupAppController(
    () => ({ rpcCall }) as unknown as ReachyMiniInstance,
    next => {
      state = next;
    },
    0
  );
  return { robot, rpcCall, controller, state: () => state };
}

describe('reading the setting', () => {
  it('reads on when the conversation app holds the slot, off otherwise', async () => {
    const on = setup(CONV_APP_NAME);
    await on.controller.refresh();
    expect(on.state()).toMatchObject({ enabled: true, otherApp: null });

    const off = setup(null);
    await off.controller.refresh();
    expect(off.state()).toMatchObject({ enabled: false, otherApp: null });
  });

  it('stays hidden on a daemon without the verb, without retrying', async () => {
    const t = setup(null);
    t.robot.fail = [rpcError('method_not_found')];
    await t.controller.refresh();
    expect(t.state().enabled).toBeNull();
    expect(t.rpcCall).toHaveBeenCalledTimes(1);
  });

  it('retries a read the link dropped', async () => {
    const t = setup(CONV_APP_NAME);
    t.robot.fail = [new Error('timed out')];
    await t.controller.refresh();
    expect(t.state().enabled).toBe(true);
    expect(t.rpcCall).toHaveBeenCalledTimes(2);
  });

  it('gives up after a few lost reads', async () => {
    const t = setup(CONV_APP_NAME);
    t.robot.fail = Array.from({ length: STARTUP_READ_ATTEMPTS }, () => new Error('closed'));
    await t.controller.refresh();
    expect(t.state().enabled).toBeNull();
    expect(t.rpcCall).toHaveBeenCalledTimes(STARTUP_READ_ATTEMPTS);
  });

  it('does not let a slow read overwrite a change made meanwhile', async () => {
    const t = setup(null);
    await t.controller.refresh();
    const read = t.controller.refresh();
    await t.controller.toggle(true);
    t.robot.startup = null; // what the stale read would have reported
    await read;
    expect(t.state().enabled).toBe(true);
  });
});

describe('changing the setting', () => {
  it('sets and clears the conversation app', async () => {
    const t = setup(null);
    await t.controller.refresh();
    await t.controller.toggle(true);
    expect(t.robot.startup).toBe(CONV_APP_NAME);
    expect(t.state()).toMatchObject({ enabled: true, busy: false, error: null });

    await t.controller.toggle(false);
    expect(t.robot.startup).toBeNull();
    expect(t.state()).toMatchObject({ enabled: false, busy: false });
  });

  it('ignores a second tap while the first is on its way', async () => {
    const t = setup(null);
    await t.controller.refresh();
    const first = t.controller.toggle(true);
    expect(t.state().busy).toBe(true);
    await t.controller.toggle(false);
    await first;
    expect(t.robot.startup).toBe(CONV_APP_NAME);
    expect(t.state()).toMatchObject({ enabled: true, busy: false });
  });

  it('puts the switch back and says why when the robot refuses', async () => {
    const t = setup(null);
    await t.controller.refresh();
    t.robot.fail = [rpcError('not_installed')];
    await t.controller.toggle(true);
    expect(t.state()).toMatchObject({ enabled: false, busy: false });
    expect(t.state().error).toMatch(/not installed/);

    // The next change clears the message.
    await t.controller.toggle(true);
    expect(t.state()).toMatchObject({ enabled: true, error: null });
  });

  it('puts the switch back when the change is lost on the way', async () => {
    const t = setup(CONV_APP_NAME);
    await t.controller.refresh();
    t.robot.fail = [new Error('timed out')];
    await t.controller.toggle(false);
    expect(t.state()).toMatchObject({ enabled: true, busy: false });
    expect(t.state().error).toMatch(/didn't answer/);
  });

  it('does nothing before the setting has been read', async () => {
    const t = setup(null);
    await t.controller.toggle(true);
    expect(t.rpcCall).not.toHaveBeenCalled();
  });
});

describe('another app in the startup slot', () => {
  it('names it, and hands the slot back when turned off again', async () => {
    const t = setup('marionette');
    await t.controller.refresh();
    expect(t.state()).toMatchObject({ enabled: false, otherApp: 'marionette' });

    await t.controller.toggle(true);
    expect(t.robot.startup).toBe(CONV_APP_NAME);
    expect(t.state()).toMatchObject({ enabled: true, otherApp: null });

    await t.controller.toggle(false);
    expect(t.robot.startup).toBe('marionette');
    expect(t.state()).toMatchObject({ enabled: false, otherApp: 'marionette' });
  });

  it('clears the slot when that app was removed meanwhile', async () => {
    const t = setup('marionette');
    await t.controller.refresh();
    await t.controller.toggle(true);
    t.robot.fail = [rpcError('not_installed')];
    await t.controller.toggle(false);
    expect(t.robot.startup).toBeNull();
    expect(t.state()).toMatchObject({ enabled: false, otherApp: null, error: null });
  });

  it('keeps naming it when taking the slot fails', async () => {
    const t = setup('marionette');
    await t.controller.refresh();
    t.robot.fail = [rpcError('unavailable')];
    await t.controller.toggle(true);
    expect(t.robot.startup).toBe('marionette');
    expect(t.state()).toMatchObject({ enabled: false, otherApp: 'marionette' });
  });
});

it('reports nothing once disposed', async () => {
  const t = setup(CONV_APP_NAME);
  const read = t.controller.refresh();
  t.controller.dispose();
  await read;
  expect(t.state()).toBe(INITIAL_STARTUP_APP_STATE);
});
