/**
 * Public-handle factory for the session engine.
 *
 * Builds the `SessionEngineHandle` object that `mountSessionEngine()`
 * returns to the React host. Each method is a thin orchestration over
 * the SDK / session helpers the engine assembled in its closure.
 *
 * Two flavours of methods live here:
 *
 *   - Lifecycle entrypoints (`unmount`, `releaseSessionKeepAwake`,
 *     `reacquireSession`): compose the lifecycle helpers passed in
 *     through `deps`.
 *   - SDK pass-throughs (`getSpeakerVolume`, `setSpeakerVolume`,
 *     `getMicrophoneVolume`, `setMicrophoneVolume`,
 *     `getDaemonVersion`, `startDaemonUpdate`, `playSound`,
 *     `subscribeLogs`, `getRobot`, `attachVideo`): wrap the SDK call
 *     with the standard "engine ready?" guard and non-throwing error
 *     handling.
 *
 * The handle holds no state of its own. Every mutable thing (the
 * `unmounted` gate, the SDK `robot` ref) is read/written through
 * getters / setters the engine passes in.
 */

import { SESSION_TIMINGS } from '@/features/robot-session/timings';
import type { RobotSession } from '@/features/robot-session/RobotSession';
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';
import type { ConnectionAttempt, ConnectionState, SessionEngineHandle } from './types';

export interface SessionHandleDeps {
  // ─── Robot + session refs ─────────────────────────────────────────
  /** Live SDK accessor. The handle bails out (returns null / no-op)
   *  on every call when this returns null. */
  getRobot: () => ReachyMiniInstance | null;
  /** Engine-side nulling of the SDK ref during `unmount()`. */
  clearRobot: () => void;
  /** Session layer (`attachVideo`, `release`, `reacquire`,
   *  `getSelectedRobotId`, `isEstablished`, `detachRobot`, …). */
  session: RobotSession;

  // ─── Unmount plumbing ─────────────────────────────────────────────
  /** Read the engine's `unmounted` flag. Each handle method
   *  short-circuits when this returns true so a late call from a
   *  stale React effect can't poke a torn-down engine. */
  isUnmounted: () => boolean;
  /** Flip the engine's `unmounted` flag to `true`. Called by
   *  `unmount()` BEFORE awaiting `bootChain` so subsequent re-entries
   *  short-circuit immediately. */
  markUnmounted: () => void;
  /** Boot-chain promise: `unmount()` awaits this (with a timeout) so
   *  we never call `robot.stopSession()` while `robot.startSession()`
   *  is still mid-flight. The chain swallows its own errors via
   *  `onFatalError`, so awaiting it cannot throw. */
  bootChain: Promise<void>;
  /** Dispose for the background-resilience module
   *  (`visibilitychange` / `pagehide` / `beforeunload` listeners). */
  disposeBackgroundResilience: () => void;

  // ─── Lifecycle composites ─────────────────────────────────────────
  /** Full teardown: goto-sleep + motors disabled + stopSession. */
  teardown: () => Promise<void>;

  // ─── State machine ────────────────────────────────────────────────
  /** Drive the transport / connection FSM (connecting → live → …). */
  setConnectionState: (state: ConnectionState) => void;

  // ─── Observer plumbing ────────────────────────────────────────────
  emitConnectionAttempt: (info: ConnectionAttempt | null) => void;
  onFatalError: (err: unknown) => Promise<void>;
}

export function createSessionHandle(deps: SessionHandleDeps): SessionEngineHandle {
  const {
    getRobot,
    clearRobot,
    session,
    isUnmounted,
    markUnmounted,
    bootChain,
    disposeBackgroundResilience,
    teardown,
    setConnectionState,
    emitConnectionAttempt,
    onFatalError,
  } = deps;

  const handle: SessionEngineHandle = {
    unmount: async () => {
      if (isUnmounted()) return;
      markUnmounted();
      disposeBackgroundResilience();
      // Wait for the in-flight boot chain to settle before teardown.
      //
      // Why: teardown() calls `robot.stopSession()`. If the boot
      // chain is still in `await robot.startSession()`, central sees
      // those two interleaved and emits `Session ended before it
      // could start: unknown reason`. By awaiting bootChain first,
      // we let startSession complete (success path) or fail (timeout
      // path inside `doStart`) before tearing down - both end states
      // leave central in a consistent slot we can stopSession on.
      //
      // The upper bound is a defensive escape hatch: bootChain
      // already has its own timeout inside `doStart` for a wedged
      // daemon, but we don't want unmount to block longer than the
      // user can tolerate (a tap on Back / power-off should feel
      // instantaneous). Value lives in
      // `SESSION_TIMINGS.bootChainUnmountTimeoutMs` for audit.
      try {
        await Promise.race([
          bootChain,
          new Promise<void>(resolve =>
            window.setTimeout(resolve, SESSION_TIMINGS.bootChainUnmountTimeoutMs)
          ),
        ]);
      } catch {
        // bootChain swallows its errors, so this catch is purely
        // defensive against the timeout race.
      }
      try {
        await teardown();
      } catch (err) {
        console.warn('[session-engine] teardown on unmount failed:', err);
      }
      // The React layer decides whether to keep the robot instance
      // alive (e.g. to reuse the HF auth). For now we disconnect so
      // subsequent mounts get a fresh state.
      try {
        getRobot()?.disconnect();
      } catch {
        // ignored
      }
      clearRobot();
      // Mirror the null on the session so its lifecycle methods can
      // see "no SDK attached" and short-circuit instead of crashing
      // on a dead ref.
      session.detachRobot();
    },

    releaseSessionKeepAwake: async () => {
      if (isUnmounted()) return;
      const robot = getRobot();
      console.log(
        `[shell-webrtc] releaseSessionKeepAwake: entering, sessionEstablished=${session.isEstablished()}, robot.state=${robot?.state}`
      );
      if (!robot || !session.isEstablished()) {
        console.log('[shell-webrtc] releaseSessionKeepAwake: no session to release, no-op');
        // Nothing to release. The host should never call this in a
        // state where there's no session, but we guard defensively so
        // a fast double-tap doesn't throw.
        return;
      }

      // Release the WebRTC session at central. The session class
      // encapsulates: setEstablished(false), reset motor cache,
      // expectedStop-wrapped stopSession, then disconnect to free the
      // SSE producer subscription. Robot stays physically awake.
      await session.release();

      // Park in `released` so the host (and any visual state observer)
      // can distinguish "we deliberately let go of the robot" from "we
      // never connected" (`connected`).
      setConnectionState('released');
    },

    reacquireSession: async () => {
      if (isUnmounted()) return;
      const robot = getRobot();
      if (!robot || !session.getSelectedRobotId()) return;
      console.log(
        `[shell-webrtc] reacquireSession: entering, sessionEstablished=${session.isEstablished()}, robot.state=${robot.state}, selectedRobotId=${session.getSelectedRobotId()}`
      );
      if (session.isEstablished()) {
        console.log('[shell-webrtc] reacquireSession: session already up, no-op');
        // Defensive: the host shouldn't call us when we're already up.
        // Make it a no-op rather than throwing so a UI race doesn't
        // crash the screen.
        return;
      }

      setConnectionState('starting');

      // `session.reacquire()` reconnects the SDK if it's dropped (we
      // disconnect during `release()` to free central's producer
      // subscription), then runs `start()` with the same retry-aware
      // helper as the initial bring-up. We do NOT call `wakeUp()` here
      // because the robot stayed physically awake during the handoff -
      // replaying the wake trajectory would freeze the head/antennas
      // back to the wake pose, defeating the "stay where you were"
      // promise of release+reacquire.
      const result = await session.reacquire({
        onAttempt: emitConnectionAttempt,
        isCancelled: () => isUnmounted(),
      });
      if (!result.ok) {
        if (result.cancelled) return;
        onFatalError(result.reason);
        return;
      }

      session.setEstablished(true);
      setConnectionState('live');
    },

    // ─── Audio volume controls ──────────────────────────────────────
    //
    // Thin pass-throughs to the SDK's DataChannel round-trips. We
    // wrap them with try/catch + null guard so the consumer can call
    // them at any time (including before the DC opens or after
    // unmount) without having to special-case the lifecycle.
    //
    // Logging is intentionally quiet: `null` returns are the expected
    // race when the DataChannel hasn't opened yet, kept at
    // `console.debug`; successful round-trips log at `info` so a
    // user-visible action stays traceable.

    getSpeakerVolume: async () => {
      const robot = getRobot();
      if (isUnmounted() || !robot) return null;
      try {
        const v = await robot.getVolume();
        if (typeof v === 'number') console.info('[volume] getSpeakerVolume →', v);
        else console.debug('[volume] getSpeakerVolume → null (DC not ready)');
        return v;
      } catch (err) {
        console.warn('[volume] getSpeakerVolume failed:', err);
        return null;
      }
    },

    setSpeakerVolume: async (volume: number) => {
      const robot = getRobot();
      if (isUnmounted() || !robot) return null;
      try {
        const applied = await robot.setVolume(volume);
        if (typeof applied === 'number') {
          console.info('[volume] setSpeakerVolume', volume, '→ applied', applied);
        } else {
          console.debug('[volume] setSpeakerVolume', volume, '→ null (DC not ready)');
        }
        return applied;
      } catch (err) {
        console.warn('[volume] setSpeakerVolume failed:', err);
        return null;
      }
    },

    getMicrophoneVolume: async () => {
      const robot = getRobot();
      if (isUnmounted() || !robot) return null;
      try {
        const v = await robot.getMicrophoneVolume();
        if (typeof v === 'number') console.info('[volume] getMicrophoneVolume →', v);
        else console.debug('[volume] getMicrophoneVolume → null (DC not ready)');
        return v;
      } catch (err) {
        console.warn('[volume] getMicrophoneVolume failed:', err);
        return null;
      }
    },

    setMicrophoneVolume: async (volume: number) => {
      const robot = getRobot();
      if (isUnmounted() || !robot) return null;
      try {
        const applied = await robot.setMicrophoneVolume(volume);
        if (typeof applied === 'number') {
          console.info('[volume] setMicrophoneVolume', volume, '→ applied', applied);
        } else {
          console.debug('[volume] setMicrophoneVolume', volume, '→ null (DC not ready)');
        }
        return applied;
      } catch (err) {
        console.warn('[volume] setMicrophoneVolume failed:', err);
        return null;
      }
    },

    getDaemonVersion: async () => {
      const robot = getRobot();
      if (isUnmounted() || !robot || typeof robot.getVersion !== 'function') {
        return null;
      }
      try {
        const v = await robot.getVersion();
        return typeof v === 'string' && v.length > 0 ? v : null;
      } catch (err) {
        console.warn('[engine] getDaemonVersion failed:', err);
        return null;
      }
    },

    startDaemonUpdate: options => {
      const robot = getRobot();
      // The daemon `start_update` command (reachy_mini#1208) is a plain
      // typed data-channel message. We send it via `sendRaw` rather than a
      // dedicated SDK helper so it works even on SDK builds that predate
      // the typed `startDaemonUpdate` method - the daemon understands the
      // wire shape regardless. Older daemons ignore it; callers gate the
      // call on a positive version check.
      if (isUnmounted() || !robot || typeof robot.sendRaw !== 'function') {
        console.warn('[engine] startDaemonUpdate: engine not ready');
        return false;
      }
      try {
        const message: { type: 'start_update'; pre_release?: boolean } = {
          type: 'start_update',
        };
        if (options?.preRelease) message.pre_release = true;
        const ok = robot.sendRaw(message);
        if (!ok) console.warn('[engine] startDaemonUpdate: data channel not open');
        return ok;
      } catch (err) {
        console.warn('[engine] startDaemonUpdate failed:', err);
        return false;
      }
    },

    playSound: (file: string) => {
      const robot = getRobot();
      if (isUnmounted() || !robot) {
        console.warn('[engine] playSound: engine not ready');
        return false;
      }
      try {
        // SDK returns false when the DataChannel isn't open. We
        // surface that to the caller so the UI can decide to skip
        // audible feedback (rather than hang on a silent failure).
        const ok = robot.playSound(file);
        if (!ok) console.warn('[engine] playSound: data channel not open');
        return ok;
      } catch (err) {
        console.warn('[engine] playSound failed:', err);
        return false;
      }
    },

    subscribeLogs: options => {
      const robot = getRobot();
      // Older SDK builds ship without `subscribeLogs`; degrade
      // gracefully to a noop so the consumer's hook stays mountable
      // without runtime guards.
      if (
        isUnmounted() ||
        !robot ||
        typeof (robot as { subscribeLogs?: unknown }).subscribeLogs !== 'function'
      ) {
        return () => {};
      }
      try {
        return robot.subscribeLogs(options);
      } catch (err) {
        console.warn('[engine] subscribeLogs failed:', err);
        return () => {};
      }
    },

    getRobot: () => {
      if (isUnmounted()) return null;
      return getRobot();
    },

    attachVideo: videoElement => {
      if (isUnmounted()) return () => {};
      try {
        return session.attachVideo(videoElement);
      } catch (err) {
        console.warn('[engine] attachVideo failed:', err);
        return () => {};
      }
    },
  };

  return handle;
}
