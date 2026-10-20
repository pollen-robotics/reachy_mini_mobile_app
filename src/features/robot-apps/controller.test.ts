/**
 * The robot-apps controller against a scripted JSON-RPC robot: wire calls,
 * job tracking from notifications and from polling, and the slot rules
 * (replace another app, clear a crashed one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { JOB_PROGRESS_METHOD } from './client';
import { JOB_SUCCESS_LINGER_MS, RobotAppsController, STATUS_POLL_MS } from './controller';

type Answer = unknown | ((params: Record<string, unknown>) => unknown);
type Handler = (params: Record<string, unknown>) => void;

function rpcError(reason: string): Error {
  return Object.assign(new Error(reason), { reason });
}

function fakeRobot(answers: Record<string, Answer>) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const handlers = new Map<string, Handler>();
  const rpcCall = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push([method, params]);
    const answer = answers[method];
    const value = typeof answer === 'function' ? answer(params) : answer;
    if (value instanceof Error) throw value;
    return value;
  });
  const onNotification = vi.fn((method: string, handler: Handler) => {
    handlers.set(method, handler);
    return () => handlers.delete(method);
  });
  const robot = Object.assign(new EventTarget(), {
    rpcCall,
    onNotification,
  }) as unknown as ReachyMiniInstance;
  const emit = (params: Record<string, unknown>) => handlers.get(JOB_PROGRESS_METHOD)?.(params);
  const methods = () => calls.map(([m]) => m);
  return { robot, calls, methods, emit, handlers };
}

const INSTALLED = {
  apps: [
    {
      name: 'marionette',
      space_id: 'pollen/marionette',
      title: 'Marionette',
      description: 'Puppet',
      emoji: '🎭',
      private: false,
      custom_app_url: 'http://0.0.0.0:7860/',
    },
  ],
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('reads', () => {
  it('lists the installed apps and the slot', async () => {
    const { robot } = fakeRobot({
      'apps.list_installed': INSTALLED,
      'apps.status': { state: 'running', info: { name: 'marionette' }, error: null },
    });
    const c = new RobotAppsController({ getRobot: () => robot });
    await c.refresh();

    const s = c.getSnapshot();
    expect(s.support).toBe('supported');
    expect(s.installed?.[0]).toMatchObject({ name: 'marionette', spaceId: 'pollen/marionette' });
    expect(s.running).toEqual({ state: 'running', name: 'marionette', error: null });
  });

  it('flags a daemon without the management verbs', async () => {
    const { robot } = fakeRobot({
      'apps.list_installed': rpcError('method_not_found'),
      'apps.status': { state: 'idle', info: null },
    });
    const c = new RobotAppsController({ getRobot: () => robot });
    await c.refresh();
    expect(c.getSnapshot().support).toBe('unsupported');
    expect(c.getSnapshot().installed).toBeNull();
  });

  it('polls only while active', async () => {
    const { robot, methods } = fakeRobot({
      'apps.list_installed': INSTALLED,
      'apps.status': { state: 'idle' },
    });
    const c = new RobotAppsController({ getRobot: () => robot });
    c.setActive(true);
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 2);
    const polled = methods().filter(m => m === 'apps.status').length;
    expect(polled).toBeGreaterThanOrEqual(3);

    c.setActive(false);
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 3);
    expect(methods().filter(m => m === 'apps.status').length).toBe(polled);
  });

  it('re-binds the progress listener when the session reconnects', async () => {
    const first = fakeRobot({ 'apps.list_installed': INSTALLED, 'apps.status': { state: 'idle' } });
    const second = fakeRobot({
      'apps.list_installed': INSTALLED,
      'apps.status': { state: 'idle' },
    });
    let robot = first.robot;
    const c = new RobotAppsController({ getRobot: () => robot });
    await c.refresh();
    expect(first.handlers.size).toBe(1);

    robot = second.robot;
    await c.refresh();
    expect(first.handlers.size).toBe(0);
    expect(second.handlers.size).toBe(1);
  });
});

describe('app slot', () => {
  it('stops another app before starting the one asked for', async () => {
    let state: Record<string, unknown> = { state: 'running', info: { name: 'other' } };
    const { robot, methods } = fakeRobot({
      'apps.list_installed': INSTALLED,
      'apps.status': () => state,
      'apps.stop': () => {
        state = { state: 'idle' };
        return { stopped: true };
      },
      'apps.start': (p: Record<string, unknown>) => {
        state = { state: 'running', info: { name: p.name } };
        return state;
      },
    });
    const c = new RobotAppsController({ getRobot: () => robot });
    await c.refresh();

    await expect(c.start('marionette')).resolves.toBe(true);
    expect(methods()).toEqual(expect.arrayContaining(['apps.stop', 'apps.start']));
    expect(methods().indexOf('apps.stop')).toBeLessThan(methods().indexOf('apps.start'));
    expect(c.getSnapshot().running.name).toBe('marionette');
    expect(c.getSnapshot().pending).toBeNull();
  });

  it('clears a crashed app holding the slot, tolerating an old daemon', async () => {
    let state: Record<string, unknown> = {
      state: 'error',
      info: { name: 'marionette' },
      error: 'exit 1',
    };
    const { robot, methods } = fakeRobot({
      'apps.list_installed': INSTALLED,
      'apps.status': () => state,
      'apps.stop': () => {
        state = { state: 'idle' };
        return rpcError('internal_error');
      },
      'apps.start': { state: 'running', info: { name: 'marionette' } },
    });
    const c = new RobotAppsController({ getRobot: () => robot });
    await c.refresh();
    expect(c.getSnapshot().running.error).toBe('exit 1');

    await expect(c.start('marionette')).resolves.toBe(true);
    expect(methods()).toContain('apps.start');
  });

  it('waits for a stop already under way before starting', async () => {
    // The Talk tab's teardown is stopping the conversation app: the stop we
    // send answers `not_running`, but the slot is held a while longer.
    let reads = 0;
    const { robot, methods } = fakeRobot({
      'apps.list_installed': INSTALLED,
      'apps.status': () =>
        reads++ < 3 ? { state: 'stopping', info: { name: 'conv' } } : { state: 'idle' },
      'apps.stop': rpcError('not_running'),
      'apps.start': { state: 'running', info: { name: 'marionette' } },
    });
    const c = new RobotAppsController({ getRobot: () => robot });
    await c.refresh();

    const started = c.start('marionette');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(started).resolves.toBe(true);
    expect(methods().filter(m => m === 'apps.status').length).toBeGreaterThanOrEqual(3);
  });

  it('drops a status read that an action overtook', async () => {
    let answerStatus: (value: unknown) => void = () => {};
    let first = true;
    const { robot } = fakeRobot({
      'apps.list_installed': INSTALLED,
      'apps.status': () => {
        if (!first) return { state: 'idle' };
        first = false;
        // The first read hangs until released, like a slow link.
        return new Promise(resolve => {
          answerStatus = resolve;
        });
      },
      'apps.start': { state: 'running', info: { name: 'marionette' } },
    });
    const c = new RobotAppsController({ getRobot: () => robot });
    const refreshed = c.refresh();
    await vi.advanceTimersByTimeAsync(0);

    await c.start('marionette');
    answerStatus({ state: 'idle' });
    await refreshed;

    expect(c.getSnapshot().running.name).toBe('marionette');
  });

  it('does nothing when the app asked for already runs', async () => {
    const { robot, methods } = fakeRobot({
      'apps.list_installed': INSTALLED,
      'apps.status': { state: 'running', info: { name: 'marionette' } },
    });
    const c = new RobotAppsController({ getRobot: () => robot });
    await c.refresh();
    await c.start('marionette');
    expect(methods()).not.toContain('apps.start');
    expect(methods()).not.toContain('apps.stop');
  });

  it('turns a refusal into a sentence and keeps going', async () => {
    const { robot } = fakeRobot({
      'apps.list_installed': INSTALLED,
      'apps.status': { state: 'idle' },
      'apps.start': rpcError('already_running'),
    });
    const c = new RobotAppsController({ getRobot: () => robot });
    await expect(c.start('marionette')).resolves.toBe(false);
    expect(c.getSnapshot().error).toMatch(/already running/);
    expect(c.getSnapshot().pending).toBeNull();
  });

  it('reports a missing robot instead of throwing', async () => {
    const c = new RobotAppsController({ getRobot: () => null });
    await expect(c.stop()).resolves.toBe(false);
    expect(c.getSnapshot().error).toMatch(/not connected/);
  });
});

describe('jobs', () => {
  it('follows an install from notifications, then refreshes and clears', async () => {
    let installedAnswer: unknown = { apps: [] };
    const fake = fakeRobot({
      'apps.list_installed': () => installedAnswer,
      'apps.status': { state: 'idle' },
      'apps.install_space': { job_id: 'j1', name: 'marionette' },
    });
    const c = new RobotAppsController({ getRobot: () => fake.robot });
    await c.refresh();

    await expect(c.install('pollen/marionette')).resolves.toBe(true);
    expect(fake.calls.find(([m]) => m === 'apps.install_space')?.[1]).toEqual({
      space_id: 'pollen/marionette',
    });
    expect(c.getSnapshot().job).toMatchObject({ id: 'j1', kind: 'install', status: 'in_progress' });

    fake.emit({
      job_id: 'j1',
      command: 'install',
      status: 'in_progress',
      line: 'Downloading',
      final: false,
    });
    expect(c.getSnapshot().job?.logs).toEqual(['Downloading']);

    installedAnswer = INSTALLED;
    fake.emit({ job_id: 'j1', command: 'install', status: 'done', line: null, final: true });
    expect(c.getSnapshot().job?.status).toBe('done');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getSnapshot().installed).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(JOB_SUCCESS_LINGER_MS);
    expect(c.getSnapshot().job).toBeNull();
  });

  it('catches up through job_status when notifications were lost', async () => {
    const fake = fakeRobot({
      'apps.list_installed': { apps: [] },
      'apps.status': { state: 'idle' },
      'apps.remove': { job_id: 'j2' },
      'apps.job_status': { status: 'failed', logs: ['boom'] },
    });
    const c = new RobotAppsController({ getRobot: () => fake.robot });
    await c.remove('marionette');
    c.setActive(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(c.getSnapshot().job).toMatchObject({ id: 'j2', status: 'failed', logs: ['boom'] });
    // A failure stays up until the user dismisses it.
    await vi.advanceTimersByTimeAsync(JOB_SUCCESS_LINGER_MS * 2);
    expect(c.getSnapshot().job?.status).toBe('failed');
    c.dismissJob();
    expect(c.getSnapshot().job).toBeNull();
    c.setActive(false);
  });

  it('keeps a final status that arrived before the reply', async () => {
    const fake = fakeRobot({
      'apps.list_installed': { apps: [] },
      'apps.status': { state: 'idle' },
      'apps.remove': () => {
        // The job failed at once; its events beat the reply.
        fake.emit({
          job_id: 'j3',
          command: 'remove',
          status: 'failed',
          line: 'boom',
          final: false,
        });
        fake.emit({ job_id: 'j3', command: 'remove', status: 'failed', line: null, final: true });
        return { job_id: 'j3' };
      },
    });
    const c = new RobotAppsController({ getRobot: () => fake.robot });
    await c.remove('marionette');
    expect(c.getSnapshot().job).toMatchObject({ id: 'j3', status: 'failed', logs: ['boom'] });
  });

  it('refuses a second job while one runs', async () => {
    const fake = fakeRobot({
      'apps.list_installed': { apps: [] },
      'apps.status': { state: 'idle' },
      'apps.install_space': { job_id: 'j1', name: 'marionette' },
    });
    const c = new RobotAppsController({ getRobot: () => fake.robot });
    await c.install('pollen/marionette');
    await expect(c.remove('other')).resolves.toBe(false);
    expect(c.getSnapshot().error).toMatch(/already installing/);
    expect(fake.calls.map(([m]) => m)).not.toContain('apps.remove');
  });

  it('drops the placeholder when the daemon refuses the install', async () => {
    const fake = fakeRobot({ 'apps.install_space': rpcError('not_found') });
    const c = new RobotAppsController({ getRobot: () => fake.robot });
    await expect(c.install('pollen/ghost')).resolves.toBe(false);
    expect(c.getSnapshot().job).toBeNull();
    expect(c.getSnapshot().error).toMatch(/could not be found/);
  });

  it('follows a job another client started', async () => {
    const fake = fakeRobot({
      'apps.list_installed': { apps: [] },
      'apps.status': { state: 'idle' },
    });
    const c = new RobotAppsController({ getRobot: () => fake.robot });
    await c.refresh();
    fake.emit({ job_id: 'x', command: 'update', status: 'in_progress', line: 'pip', final: false });
    expect(c.getSnapshot().job).toMatchObject({ id: 'x', kind: 'update', logs: ['pip'] });
  });
});

describe('link drops', () => {
  it('says why a call that never reached the robot failed', async () => {
    const { robot } = fakeRobot({
      'apps.status': { state: 'idle' },
      'apps.start': new Error('rpcCall(apps.start): data channel not open'),
      'apps.stop': new Error('rpcCall(apps.stop) timed out after 30000ms'),
    });
    const c = new RobotAppsController({ getRobot: () => robot });

    await c.start('marionette');
    expect(c.getSnapshot().error).toMatch(/Reconnecting to Reachy/);

    await c.stop();
    expect(c.getSnapshot().error).toMatch(/didn't answer in time/);
  });

  it('refuses actions while offline without touching the link', async () => {
    const { robot, methods } = fakeRobot({ 'apps.status': { state: 'idle' } });
    const c = new RobotAppsController({ getRobot: () => robot });
    c.setOnline(false);

    await expect(c.start('marionette')).resolves.toBe(false);
    await expect(c.install('pollen/marionette')).resolves.toBe(false);
    expect(c.getSnapshot()).toMatchObject({ online: false, job: null });
    expect(c.getSnapshot().error).toMatch(/Reconnecting/);
    expect(methods()).not.toContain('apps.start');
    expect(methods()).not.toContain('apps.install_space');
  });

  it('re-syncs from the robot when the link comes back', async () => {
    const { robot, methods } = fakeRobot({
      'apps.list_installed': INSTALLED,
      'apps.status': { state: 'running', info: { name: 'marionette' } },
    });
    const c = new RobotAppsController({ getRobot: () => robot });
    c.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    c.setOnline(false);
    const before = methods().filter(m => m === 'apps.list_installed').length;

    c.setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(methods().filter(m => m === 'apps.list_installed').length).toBe(before + 1);
    c.setActive(false);
  });

  it('goes offline during an SDK re-dial and catches up on the job after it', async () => {
    let jobStatusCalls = 0;
    const { robot, emit } = fakeRobot({
      'apps.list_installed': { apps: [] },
      'apps.status': { state: 'idle' },
      'apps.install_space': { job_id: 'j9', name: 'marionette' },
      'apps.job_status': () => {
        jobStatusCalls += 1;
        return { status: 'done', logs: ['installed while we were away'] };
      },
    });
    const c = new RobotAppsController({ getRobot: () => robot });
    await c.install('pollen/marionette');
    // A progress event keeps the regular poll quiet...
    emit({ job_id: 'j9', command: 'install', status: 'in_progress', line: 'x', final: false });

    robot.dispatchEvent(new Event('sessionReconnecting'));
    expect(c.getSnapshot().online).toBe(false);

    robot.dispatchEvent(new Event('sessionReconnected'));
    await vi.advanceTimersByTimeAsync(0);
    // ...but a reconnect polls the job at once: its last events may be lost.
    expect(c.getSnapshot().online).toBe(true);
    expect(jobStatusCalls).toBe(1);
    expect(c.getSnapshot().job?.status).toBe('done');
  });
});

describe('apps.update reply', () => {
  it('follows the job #1471 returns, also when one already runs', async () => {
    const fake = fakeRobot({
      'apps.list_installed': INSTALLED,
      'apps.status': { state: 'idle' },
      'apps.update': { started: false, job_id: 'u1' },
    });
    const c = new RobotAppsController({ getRobot: () => fake.robot });
    await expect(c.update('marionette')).resolves.toBe(true);
    expect(c.getSnapshot().job).toMatchObject({ id: 'u1', kind: 'update' });
  });

  it('reports busy when the daemon starts nothing', async () => {
    const fake = fakeRobot({ 'apps.update': { started: false } });
    const c = new RobotAppsController({ getRobot: () => fake.robot });
    await expect(c.update('marionette')).resolves.toBe(false);
    expect(c.getSnapshot().error).toMatch(/already installing/);
  });
});
