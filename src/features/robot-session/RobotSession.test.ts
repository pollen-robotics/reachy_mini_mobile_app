/**
 * Tests for the iframe handoff path on `RobotSession`.
 *
 * Scope (focused on the audit follow-up)
 * ──────────────────────────────────────
 * The iframe-handoff sequence is the single most fragile part of
 * the parcours `connect → open app → close app → back to conv`. It
 * goes through `release()` (engine-driven, called from
 * `releaseSessionKeepAwake()` in the conversation engine) and
 * `reacquire()` (engine-driven, called from `reacquireSession()`).
 *
 * Both are pure session-layer methods, no React / SDK runtime
 * needed - they can be exercised with a hand-rolled mock of
 * `ReachyMiniInstance`. The tests below assert:
 *
 *   1. Both methods are safe to call out of order (no-op when there
 *      is nothing to release / when already up).
 *   2. `release()` runs the SDK calls in the right order
 *      (`stopSession` THEN `disconnect`) and resets the in-memory
 *      bookkeeping (`established`, motor mode cache).
 *   3. `reacquire()` reconnects the SDK if it dropped, then runs
 *      `start()` (which goes through the retry loop helper) - and
 *      DOES NOT replay the wake-up trajectory (the robot stayed
 *      awake during the handoff).
 *   4. `stopSession()` calls go through `expectedStop` so the
 *      engine's `sessionStopped` listener can distinguish them
 *      from unsolicited drops.
 *
 * These are exactly the invariants that, if broken silently by a
 * future refactor, would resurface as "session ended before it
 * could start: unknown reason" or "robot stayed busy on next launch"
 * type bugs - the exact issues the architecture was designed to
 * prevent. A pinning test is the cheapest insurance.
 *
 * Why not RTL / jsdom
 * ───────────────────
 * The repo's `vitest.config.ts` deliberately avoids `jsdom` - the
 * convention is "tests target pure utility functions only". A
 * `RobotSession` instance is a pure utility (no React, no DOM, no
 * timers in the happy path), so it slots into that convention
 * cleanly.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ReachyMiniInstance } from './sdk-types';
import { RobotSession } from './RobotSession';

// `start-session.ts` calls `window.setTimeout` (the WebView-native
// alias of the global timer). Node's vitest environment doesn't
// define `window`, so we polyfill a minimal shim BEFORE we touch
// `RobotSession.start()` below. Cheaper than pulling in `jsdom` and
// preserves the repo convention of testing pure utilities only.
//
// Both `setTimeout` and `clearTimeout` are spec-identical between
// Node and browsers for our use cases (we only feed numeric `ms`
// and we don't rely on the return type beyond passing it back to
// `clearTimeout`).
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  (globalThis as { window: typeof globalThis }).window = globalThis;
}

interface MockRobot extends ReachyMiniInstance {
  /** Test-only spy hooks; counts how many times each lifecycle SDK
   *  call was made and in which order. */
  calls: Array<'connect' | 'disconnect' | 'startSession' | 'stopSession'>;
}

/**
 * Minimal `ReachyMiniInstance` mock. Only the surface that
 * `RobotSession` touches is implemented; the rest throws so a
 * future test that accidentally reaches into an unmocked area
 * fails loudly rather than silently returning `undefined`.
 *
 * `state` is mutable to exercise the disconnected → connected
 * transitions that drive `release()` / `reacquire()`.
 */
function createMockRobot(): MockRobot {
  const calls: MockRobot['calls'] = [];
  let state: ReachyMiniInstance['state'] = 'connected';
  const robot = {
    get state() {
      return state;
    },
    robots: [],
    username: null,
    isAuthenticated: true,
    micSupported: false,
    micMuted: false,
    audioMuted: false,
    _pc: null,
    calls,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    authenticate: vi.fn(async () => true),
    login: vi.fn(async () => undefined),
    logout: vi.fn(),
    async connect(): Promise<void> {
      calls.push('connect');
      state = 'connected';
    },
    disconnect(): void {
      calls.push('disconnect');
      state = 'disconnected';
    },
    async startSession(): Promise<void> {
      calls.push('startSession');
      state = 'streaming';
    },
    async stopSession(): Promise<void> {
      calls.push('stopSession');
      state = 'connected';
    },
    attachVideo: vi.fn(() => () => {}),
    setHeadRpyDeg: vi.fn(() => true),
    setAntennasDeg: vi.fn(() => true),
    setBodyYawDeg: vi.fn(() => true),
    playSound: vi.fn(() => true),
    wakeUp: vi.fn(async () => undefined),
    gotoSleep: vi.fn(async () => undefined),
    setMotorMode: vi.fn(() => true),
    sendRaw: vi.fn(() => true),
    setAudioMuted: vi.fn(),
    setMicMuted: vi.fn(),
    getVolume: vi.fn(async () => null),
    setVolume: vi.fn(async () => null),
    getMicrophoneVolume: vi.fn(async () => null),
    setMicrophoneVolume: vi.fn(async () => null),
    applyAudioConfig: vi.fn(async () => true),
    readAudioParameter: vi.fn(async () => null),
    getVersion: vi.fn(async () => null),
    subscribeLogs: vi.fn(() => () => {}),
  } as unknown as MockRobot;
  return robot;
}

/**
 * Bring a fresh `RobotSession` up to the "session established"
 * state used as the precondition of every handoff scenario. Uses
 * the real `start()` flow (no mock-out of `startRobotSession`) so
 * the test exercises the actual code path consumers will use.
 *
 * Healthy mock = the first `startSession()` attempt resolves
 * immediately, so we never hit the 8s/12s retry timers and don't
 * need fake timers in these tests.
 */
async function setupEstablishedSession(): Promise<{
  session: RobotSession;
  robot: MockRobot;
}> {
  const session = new RobotSession();
  const robot = createMockRobot();
  session.attachRobot(robot);
  session.setSelectedRobotId('robot-1');
  const result = await session.start();
  if (!result.ok) throw new Error('start() should have succeeded in test setup');
  session.setEstablished(true);
  session.recordMotorMode('enabled');
  // Reset the call log so each test starts from a clean snapshot
  // of "what the session is about to do" without the bring-up
  // noise in the way.
  robot.calls.length = 0;
  return { session, robot };
}

describe('RobotSession - iframe handoff (release + reacquire)', () => {
  describe('release()', () => {
    it('is a no-op when the session has not been established', async () => {
      const session = new RobotSession();
      const robot = createMockRobot();
      session.attachRobot(robot);
      session.setSelectedRobotId('robot-1');

      await session.release();

      // No SDK call should have happened: the engine should never
      // even attempt a stopSession against a session that was
      // never up. This guards against "fast double-tap on close"
      // accidentally tearing down a fresh handshake.
      expect(robot.calls).toEqual([]);
      expect(session.isEstablished()).toBe(false);
    });

    it('calls stopSession then disconnect in that order, and resets bookkeeping', async () => {
      const { session, robot } = await setupEstablishedSession();

      await session.release();

      // The exact order matters: stopSession lets central know the
      // session is over (so it frees the producer slot) BEFORE we
      // tear the SDK's SSE subscription via disconnect. Inverted,
      // central would see the SSE drop first and could end the
      // session on its own, racing our stopSession.
      expect(robot.calls).toEqual(['stopSession', 'disconnect']);
      expect(session.isEstablished()).toBe(false);
      expect(session.getLastMotorMode()).toBeNull();
    });
  });

  describe('reacquire()', () => {
    it('is a no-op when the session is already established', async () => {
      const { session, robot } = await setupEstablishedSession();

      const result = await session.reacquire();

      expect(result).toEqual({ ok: true });
      // No SDK calls: reacquire on an already-up session means the
      // host raced its own close → reacquire transition. Falling
      // through to start() would re-handshake against the still-
      // live peer and central would reject it.
      expect(robot.calls).toEqual([]);
    });

    it('reconnects the SDK and starts a new session after a release', async () => {
      const { session, robot } = await setupEstablishedSession();

      await session.release();
      robot.calls.length = 0;
      const result = await session.reacquire();

      expect(result).toEqual({ ok: true });
      // The release dropped us to `disconnected`, so reacquire
      // MUST reconnect before starting. `wakeUp` is NOT in the
      // sequence: the robot stayed physically awake during the
      // handoff, replaying the wake trajectory would defeat the
      // "stay where you were" promise.
      expect(robot.calls).toEqual(['connect', 'startSession']);
      expect(robot.wakeUp).not.toHaveBeenCalled();
    });

    it('skips connect() if the SDK is still connected', async () => {
      const { session, robot } = await setupEstablishedSession();

      // Simulate `release()` partial: only stopSession ran (e.g.
      // the engine called release at a different layer or a
      // future refactor split the steps). The session knows it's
      // not established but the SDK is still subscribed to
      // central.
      session.setEstablished(false);
      robot.calls.length = 0;
      const result = await session.reacquire();

      expect(result).toEqual({ ok: true });
      // No `connect` because the SDK is still connected; only the
      // session-layer startSession is needed.
      expect(robot.calls).toEqual(['startSession']);
    });

    it('returns the connect error when the SDK refuses to reconnect', async () => {
      const { session, robot } = await setupEstablishedSession();
      await session.release();
      robot.connect = vi.fn(async () => {
        throw new Error('central unreachable');
      });
      robot.calls.length = 0;

      const result = await session.reacquire();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason.message).toBe('central unreachable');
      }
      // We must not have proceeded to startSession - that would
      // dial central with a stale subscription state.
      expect(robot.calls).toEqual([]);
    });

    it('returns an error when no peer id is selected', async () => {
      const session = new RobotSession();
      const robot = createMockRobot();
      session.attachRobot(robot);

      const result = await session.reacquire();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason.message).toMatch(/peer id missing/i);
      }
    });
  });

  describe('expectedStop wiring', () => {
    it('routes release()-time stopSession through expectedStop', async () => {
      const { session, robot } = await setupEstablishedSession();
      const beforeRelease = session.guard.hasPendingExpectedStop();

      // Capture mid-release that the guard had been bumped: the
      // engine's `sessionStopped` listener will check exactly this
      // flag to decide whether to fire its unsolicited-drop
      // recovery path. If a release ever stopped going through
      // `expectedStop`, the listener would think central evicted
      // us and would race the engine's own cleanup.
      let pendingDuringRelease = false;
      robot.stopSession = vi.fn(async () => {
        pendingDuringRelease = session.guard.hasPendingExpectedStop();
      });

      await session.release();

      expect(beforeRelease).toBe(false);
      expect(pendingDuringRelease).toBe(true);
    });
  });
});
