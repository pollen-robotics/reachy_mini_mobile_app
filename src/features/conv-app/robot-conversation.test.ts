/**
 * The start sequence and the turn→state mapping of the on-robot conversation.
 *
 * Fakes the robot's JSON-RPC surface method by method, so the test drives
 * the real sequencing (status → start → readiness poll → follow) and the
 * real mapping without a robot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationState } from '@/features/conversation/engine/types';
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { cacheFacts, getFacts } from './memory-cache';
import { createRobotConversation, type RobotConversationDeps } from './robot-conversation';

type Handler = (params: Record<string, unknown>) => void;

function fakeRobot(
  answers: Record<string, unknown | ((params: Record<string, unknown>) => unknown)>
) {
  const calls: string[] = [];
  const handlers = new Map<string, Handler>();
  const rpcCall = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push(method);
    const answer = answers[method];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(params) : answer;
  });
  const onNotification = vi.fn((method: string, handler: Handler) => {
    handlers.set(method, handler);
    return () => handlers.delete(method);
  });
  const robot = { rpcCall, onNotification } as unknown as ReachyMiniInstance;
  const emit = (method: string, params: Record<string, unknown>) => handlers.get(method)?.(params);
  return { robot, calls, emit, handlers };
}

function harness(robot: ReachyMiniInstance) {
  const states: ConversationState[] = [];
  let state: ConversationState = 'idle';
  const errors: Array<string | null> = [];
  const deps: RobotConversationDeps = {
    getRobot: () => robot,
    isUnmounted: () => false,
    setConversationState: next => {
      state = next;
      states.push(next);
    },
    currentConversationState: () => state,
    emitErrorMessage: message => errors.push(message),
    getLevelsTarget: () => null,
    onLevels: null,
    onToolToast: vi.fn(),
  };
  return { conversation: createRobotConversation(deps), states, errors, deps };
}

const READY = {
  backend_connected: true,
  has_hf_connection: true,
  backend_error: null,
  language: 'en',
  memory_enabled: true,
  vision_enabled: true,
};

beforeEach(() => {
  cacheFacts([]);
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('start', () => {
  it('starts the app on an idle robot, waits for its backend, then listens', async () => {
    const { robot, calls } = fakeRobot({
      'apps.status': { state: 'idle' },
      'apps.start': {},
      'conversation.status': READY,
      'memory.list': { facts: [] },
    });
    const { conversation, states } = harness(robot);

    await expect(conversation.start()).resolves.toBe(true);

    // memory.list is the settings sync refreshing the phone's cache.
    expect(calls).toEqual(['apps.status', 'apps.start', 'conversation.status', 'memory.list']);
    expect(states).toEqual(['starting', 'listening']);
  });

  it('adopts a conversation app that is already running', async () => {
    const { robot, calls } = fakeRobot({
      'apps.status': { state: 'running', info: { name: 'reachy_mini_conversation_app' } },
      'conversation.status': READY,
    });
    const { conversation } = harness(robot);

    await expect(conversation.start()).resolves.toBe(true);
    expect(calls).not.toContain('apps.start');
  });

  it('never takes the robot away from another app', async () => {
    const { robot, calls } = fakeRobot({
      'apps.status': { state: 'running', info: { name: 'hand_tracker' } },
    });
    const { conversation, states, errors } = harness(robot);

    await expect(conversation.start()).resolves.toBe(false);

    expect(calls).toEqual(['apps.status']);
    expect(states).toEqual(['starting', 'idle']);
    expect(errors.at(-1)).toMatch(/busy with hand_tracker/);
  });

  it('installs then retries when the robot refuses the start with a reason', async () => {
    let installed = false;
    const { robot, calls } = fakeRobot({
      'apps.status': { state: 'idle' },
      'apps.start': () => {
        if (!installed) throw Object.assign(new Error('unknown app'), { reason: 'internal_error' });
        return {};
      },
      'apps.install': () => {
        installed = true;
        return { installed: true };
      },
      'conversation.status': READY,
      'memory.list': { facts: [] },
    });
    const { conversation } = harness(robot);

    await expect(conversation.start()).resolves.toBe(true);
    expect(calls).toEqual([
      'apps.status',
      'apps.start',
      'apps.install',
      'apps.start',
      'conversation.status',
      'memory.list',
    ]);
  });

  it('does not install on a transport failure, which a reinstall cannot fix', async () => {
    const { robot, calls } = fakeRobot({
      'apps.status': { state: 'idle' },
      'apps.start': new Error('rpcCall(apps.start) timed out after 60000ms'),
    });
    const { conversation, errors } = harness(robot);

    await expect(conversation.start()).resolves.toBe(false);
    expect(calls).not.toContain('apps.install');
    expect(errors.at(-1)).toMatch(/Lost the robot/);
  });

  it('tells the user to sign the robot in when it has no Hugging Face connection', async () => {
    const { robot } = fakeRobot({
      'apps.status': { state: 'idle' },
      'apps.start': {},
      'conversation.status': { ...READY, backend_connected: false, has_hf_connection: false },
    });
    const { conversation, errors } = harness(robot);

    await expect(conversation.start()).resolves.toBe(false);
    expect(errors.at(-1)).toMatch(/Hugging Face/);
  });

  it('keeps polling while the app boots and gives up with the backend error', async () => {
    let polls = 0;
    const { robot } = fakeRobot({
      'apps.status': { state: 'idle' },
      'apps.start': {},
      'conversation.status': () => {
        polls += 1;
        if (polls === 1) throw Object.assign(new Error('no app'), { reason: 'not_running' });
        return { ...READY, backend_connected: false, backend_error: 'allocator 503' };
      },
    });
    const { conversation, errors } = harness(robot);

    const started = conversation.start();
    await vi.advanceTimersByTimeAsync(61_000);

    await expect(started).resolves.toBe(false);
    expect(polls).toBeGreaterThan(1);
    expect(errors.at(-1)).toMatch(/allocator 503/);
  });
});

describe('following the robot', () => {
  async function live() {
    const fake = fakeRobot({
      'apps.status': { state: 'idle' },
      'apps.start': {},
      'apps.stop': {},
      'conversation.status': READY,
      'memory.list': { facts: [] },
      'conversation.mic': (params: Record<string, unknown>) => ({ muted: params.muted }),
    });
    const h = harness(fake.robot);
    await h.conversation.start();
    h.states.length = 0;
    return { ...fake, ...h };
  }

  it('maps the robot turn vocabulary onto the orb states', async () => {
    const { emit, states } = await live();

    emit('conversation.turn', { state: 'thinking' });
    emit('conversation.turn', { state: 'speaking' });
    emit('conversation.turn', { state: 'ready' });
    emit('conversation.turn', { state: 'nonsense' });

    expect(states).toEqual(['processing', 'ai-speaking', 'listening']);
  });

  it('routes the mute switch to the robot', async () => {
    const { conversation, calls } = await live();

    conversation.setMicMuted(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.at(-1)).toBe('conversation.mic');
  });

  it('re-reads the memory after a tool call, so the counter follows', async () => {
    // The robot's `remember` tool writes a fact mid-conversation; the phone
    // only learns about it by asking again.
    let reads = 0;
    const { robot, calls, emit } = fakeRobot({
      'apps.status': { state: 'idle' },
      'apps.start': {},
      'conversation.status': READY,
      'memory.list': () => ({
        facts: reads++ === 0 ? [] : [{ id: 'm_1', text: 'Has a dog', createdAt: 1 }],
      }),
    });
    const { conversation } = harness(robot);
    await conversation.start();
    expect(getFacts()).toEqual([]);

    emit('conversation.activity', { reason: 'tool_result_ready' });
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.at(-1)).toBe('memory.list');
    expect(getFacts()).toHaveLength(1);
  });

  it('stops the app and unsubscribes on stop', async () => {
    const { conversation, calls, handlers } = await live();
    expect(handlers.size).toBe(3);

    await conversation.stop();

    expect(calls.at(-1)).toBe('apps.stop');
    expect(handlers.size).toBe(0);
    await conversation.stop();
    expect(calls.filter(c => c === 'apps.stop')).toHaveLength(1);
  });
});
