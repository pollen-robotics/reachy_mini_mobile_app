/**
 * Public-handle factory for the conversation engine.
 *
 * Builds the `ConversationEngineHandle` object that
 * `mountConversation()` returns to the React host. Each method is
 * a thin orchestration over the SDK / session / pipeline helpers
 * the engine assembled in its closure - we just gather them
 * behind a `deps` shape so the main file stays focused on the
 * FSM + the bring-up logic.
 *
 * Three flavours of methods live here:
 *
 *   - Lifecycle entrypoints (`unmount`, `startConversation`,
 *     `stopConversation`, `restartConversation`,
 *     `releaseSessionKeepAwake`, `reacquireSession`,
 *     `setMicMuted`, `requestStop`, `triggerOrbAction`):
 *     compose the lifecycle helpers passed in through `deps`.
 *   - SDK pass-throughs (`getSpeakerVolume`, `setSpeakerVolume`,
 *     `getMicrophoneVolume`, `setMicrophoneVolume`,
 *     `getDaemonVersion`, `playSound`, `setHeadRpyDeg`,
 *     `setBodyYawDeg`, `subscribeLogs`, `attachVideo`): wrap the
 *     SDK call with the standard "engine ready?" guard and
 *     non-throwing error handling.
 *   - Read accessors (`getMicLevel`): expose engine-cached values.
 *
 * The handle holds no state of its own. Every mutable thing
 * (`unmounted`, `conversationStarted`, `convoActiveRequested`,
 * the SDK `robot` ref) is read/written through getters / setters
 * the engine passes in.
 */

import { SESSION_TIMINGS } from "@/features/robot-session/timings";
import type { RobotSession } from "@/features/robot-session/RobotSession";
import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";
import type {
  AppState,
  ConversationConnectionAttempt,
  ConversationEngineHandle,
} from "./types";

export interface ConversationHandleDeps {
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
  /** Dispose for the optional vision side-channel. No-op when
   *  vision was never attached. */
  disposeVision: () => void;

  // ─── Conversation gates (mutable) ─────────────────────────────────
  /** True once the conversation parts (antennas, backend, wobbler) are
   *  running. Prevents double-start. */
  isConversationStarted: () => boolean;
  /** True when the host has opted into running the conversation
   *  parts. Toggled by `startConversation` / `stopConversation`. */
  isConvoActiveRequested: () => boolean;
  setConvoActiveRequested: (value: boolean) => void;

  // ─── Pipeline composites ──────────────────────────────────────────
  /** Bring the antennas oscillator + HF realtime + wobbler up. */
  runConversationParts: () => Promise<void>;
  /** Tear the conversation pipeline down. `glide: true` adds a 700 ms
   *  ease-out to neutral (`stopConversation` /
   *  `releaseSessionKeepAwake` paths); `glide: false` skips it for
   *  the power-off path where `gotoSleep` owns the head trajectory. */
  tearDownConversationPipeline: (opts: { glide: boolean }) => Promise<void>;
  /** Full teardown: stop pipeline (no glide) + goto-sleep + stopSession. */
  teardown: () => Promise<void>;

  // ─── Host-action handlers (orb / mute / stop) ─────────────────────
  applyMicMuted: (muted: boolean) => void;
  handleHostStop: () => Promise<void>;
  handleOrbClick: () => Promise<void>;

  // ─── State machine ────────────────────────────────────────────────
  setState: (state: AppState) => void;

  // ─── Observer plumbing ────────────────────────────────────────────
  emitConnectionAttempt: (info: ConversationConnectionAttempt | null) => void;
  onFatalError: (err: unknown) => Promise<void>;

  // ─── Cached values ────────────────────────────────────────────────
  /** Latest smoothed mic level in `[0..1]` from the audio monitors
   *  controller. */
  getMicLevel: () => number;
}

export function createConversationHandle(
  deps: ConversationHandleDeps,
): ConversationEngineHandle {
  const {
    getRobot,
    clearRobot,
    session,
    isUnmounted,
    markUnmounted,
    bootChain,
    disposeBackgroundResilience,
    disposeVision,
    isConversationStarted,
    isConvoActiveRequested,
    setConvoActiveRequested,
    runConversationParts,
    tearDownConversationPipeline,
    teardown,
    applyMicMuted,
    handleHostStop,
    handleOrbClick,
    setState,
    emitConnectionAttempt,
    onFatalError,
    getMicLevel,
  } = deps;

  const handle: ConversationEngineHandle = {
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
      // already has its own 15 s timeout inside `doStart` for a
      // wedged daemon, but we don't want unmount to block longer
      // than the user can tolerate (a tap on Back / power-off should
      // feel instantaneous). The current budget covers the common
      // cases (auth + connect + a brief startSession) without sitting
      // through the worst-case 15 s timeout. Value lives in
      // `SESSION_TIMINGS.bootChainUnmountTimeoutMs` for audit.
      try {
        await Promise.race([
          bootChain,
          new Promise<void>((resolve) =>
            window.setTimeout(
              resolve,
              SESSION_TIMINGS.bootChainUnmountTimeoutMs,
            ),
          ),
        ]);
      } catch {
        // bootChain swallows its errors, so this catch is purely
        // defensive against the timeout race.
      }
      try {
        await teardown();
      } catch (err) {
        console.warn("[conversation-engine] teardown on unmount failed:", err);
      }
      // Terminal release of the vision side-channel. `teardown()`
      // above already stopped its timers; `dispose()` drops the
      // in-memory state so a hypothetical late `start()` after
      // unmount is a guaranteed no-op.
      disposeVision();
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

    startConversation: async () => {
      if (isUnmounted()) return;
      if (isConvoActiveRequested() && isConversationStarted()) return;
      setConvoActiveRequested(true);
      // Two cases:
      //   1. The SDK session is already up (we parked in `doStart`
      //      after `setSessionEstablished(true)` because auto-start
      //      was off). Resume by running the conversation parts now.
      //   2. The SDK session isn't up yet (e.g. host called
      //      startConversation before robotsChanged fired). The flag
      //      is now set, so when `doStart` runs it'll fall through
      //      to `runConversationParts()` directly instead of
      //      returning early.
      if (session.isEstablished() && !isConversationStarted()) {
        try {
          await runConversationParts();
        } catch (err) {
          console.warn(
            "[conversation-engine] startConversation failed:",
            err,
          );
        }
      }
    },

    stopConversation: async () => {
      if (isUnmounted()) return;
      // Flip the orb to its "ending" spinner IMMEDIATELY, before the
      // teardown below. That teardown is deliberately gentle (a 700 ms
      // glide-to-neutral run in parallel with the OpenAI bridge close),
      // so without this the orb would keep showing the live
      // conversation state for the whole wind-down and the stop tap
      // would feel unresponsive. `stopping` maps to the spinner in the
      // orb; we leave it for `ready` once teardown settles.
      setState("stopping");
      // "Lite" teardown: stop the conversation pipeline (D layer) but
      // leave the SDK / DataChannel alive so the daemon proxy keeps
      // working. The helper takes care of the convo gate, motion
      // controllers, realtime bridge, audio monitors and gentle
      // ease-out to neutral. It is also idempotent when no
      // conversation is currently running.
      await tearDownConversationPipeline({ glide: true });
      // Drop back to the "session up, no convo" parking state so the
      // host can call `startConversation()` again later without the
      // engine's UI lying about its current capabilities. `ready`
      // (not `connected`) is the right target: the SDK + DataChannel
      // are still up and motors are still enabled - the user only
      // dismissed the AI side. The accompanying `setMotorMode(
      // 'gravity_compensation')` (driven by `syncMotorModeForState`)
      // silences the Dynamixel idle buzz now that we've landed on
      // a known neutral pose just above.
      if (session.isEstablished()) {
        setState("ready");
      } else {
        // Session vanished mid-teardown (not reachable from the mobile
        // stop button, which only shows with an established session) -
        // don't strand the orb on its "ending" spinner.
        setState("connected");
      }
    },

    restartConversation: async () => {
      if (isUnmounted()) return;
      // Mid-session personality switch: the active personality is read
      // lazily by both `composeInstructions` and the `voice` getter
      // (see `createHuggingFaceBridge` deps), so the next reconnect
      // automatically picks up the new instructions + voice. We just
      // need to drop the live realtime client and bring it back.
      //
      // No-op when the conversation isn't running: a future
      // `startConversation()` will already pull the fresh personality
      // values, so there's nothing to reload here.
      if (!isConversationStarted() && !isConvoActiveRequested()) return;
      try {
        await handle.stopConversation();
        if (isUnmounted()) return;
        await handle.startConversation();
      } catch (err) {
        console.warn("[conversation-engine] restartConversation failed:", err);
      }
    },

    setMicMuted: (muted: boolean) => {
      if (isUnmounted()) return;
      applyMicMuted(muted);
    },

    requestStop: async () => {
      if (isUnmounted()) return;
      try {
        await handleHostStop();
      } catch (err) {
        console.warn("[conversation-engine] requestStop failed:", err);
      }
    },

    triggerOrbAction: async () => {
      if (isUnmounted()) return;
      try {
        await handleOrbClick();
      } catch (err) {
        console.warn("[conversation-engine] triggerOrbAction failed:", err);
      }
    },

    releaseSessionKeepAwake: async () => {
      if (isUnmounted()) return;
      const robot = getRobot();
      console.log(
        `[shell-webrtc] releaseSessionKeepAwake: entering, sessionEstablished=${session.isEstablished()}, robot.state=${robot?.state}, conversationStarted=${isConversationStarted()}`,
      );
      if (!robot || !session.isEstablished()) {
        console.log(
          "[shell-webrtc] releaseSessionKeepAwake: no session to release, no-op",
        );
        // Nothing to release. The host should never call this in a
        // state where there's no session, but we guard defensively so
        // a fast double-tap doesn't throw.
        return;
      }

      // Step 1 - stop the running conversation pipeline (D layer) with
      // the gentle ease-out so the iframe takes over a calmly-posed
      // robot. Helper is idempotent when no conversation is currently
      // active.
      await tearDownConversationPipeline({ glide: true });

      // Step 2 - release the WebRTC session at central. The session
      // class encapsulates: setEstablished(false), reset motor cache,
      // expectedStop-wrapped stopSession, then disconnect to free the
      // SSE producer subscription. Robot stays physically awake.
      await session.release();

      // Step 3 - park in `released` so the host (and any visual state
      // observer) can distinguish "we deliberately let go of the robot"
      // from "we never connected" (`connected`) or "we're tearing down
      // for a goodbye" (no explicit state, the panel unmounts).
      setState("released");
    },

    reacquireSession: async () => {
      if (isUnmounted()) return;
      const robot = getRobot();
      if (!robot || !session.getSelectedRobotId()) return;
      console.log(
        `[shell-webrtc] reacquireSession: entering, sessionEstablished=${session.isEstablished()}, robot.state=${robot.state}, selectedRobotId=${session.getSelectedRobotId()}`,
      );
      if (session.isEstablished()) {
        console.log(
          "[shell-webrtc] reacquireSession: session already up, no-op",
        );
        // Defensive: the host shouldn't call us when we're already up.
        // Make it a no-op rather than throwing so a UI race doesn't
        // crash the screen.
        return;
      }

      setState("starting");

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

      // Mark session up and park in `ready`. The conversation parts
      // are intentionally NOT auto-resumed: the host stops the
      // conversation when the user leaves the conversation tab (see
      // `RobotSessionScreen`), so by the time we're reacquiring after
      // an iframe handoff there's nothing to resume - the user is
      // back on the conv tab and will tap the orb to start a fresh
      // conversation.
      session.setEstablished(true);
      setState("ready");
    },

    attachVideo: (videoElement: HTMLVideoElement) => {
      if (isUnmounted()) return () => {};
      // `session.attachVideo` already handles the no-robot guard +
      // late-attach catch-up via the cache (the SDK's `videoTrack`
      // event is a one-shot fired during session negotiation; the
      // cache replay fixes the common "camera card mounts AFTER
      // hasReachedReady" race). Returns the SDK's detach callback.
      return session.attachVideo(videoElement);
    },

    // ─── Audio volume controls ──────────────────────────────────────
    //
    // Thin pass-throughs to the SDK's DataChannel round-trips. We
    // wrap them with try/catch + null guard so the consumer can call
    // them at any time (including before the DC opens or after
    // unmount) without having to special-case the lifecycle.
    //
    // Volume getters/setters keep the same `Promise<number | null>`
    // contract as before; logging is intentionally quiet:
    //   - `null` returns are the expected race when the DataChannel
    //     hasn't opened yet (or just torn down for a release). The
    //     `useDaemonState` provider retries once on null, so flooding
    //     the console with "→ null" on every bring-up was just noise.
    //     We keep them at `console.debug` so devs who need them can
    //     filter the level up; the default browser console hides
    //     debug.
    //   - Successful round-trips and writes still log at `info` so
    //     a user-visible action is traceable in the console.

    getSpeakerVolume: async () => {
      const robot = getRobot();
      if (isUnmounted() || !robot) return null;
      try {
        const v = await robot.getVolume();
        if (typeof v === "number") console.info("[volume] getSpeakerVolume →", v);
        else console.debug("[volume] getSpeakerVolume → null (DC not ready)");
        return v;
      } catch (err) {
        console.warn("[volume] getSpeakerVolume failed:", err);
        return null;
      }
    },

    setSpeakerVolume: async (volume: number) => {
      const robot = getRobot();
      if (isUnmounted() || !robot) return null;
      try {
        const applied = await robot.setVolume(volume);
        if (typeof applied === "number") {
          console.info(
            "[volume] setSpeakerVolume",
            volume,
            "→ applied",
            applied,
          );
        } else {
          console.debug(
            "[volume] setSpeakerVolume",
            volume,
            "→ null (DC not ready)",
          );
        }
        return applied;
      } catch (err) {
        console.warn("[volume] setSpeakerVolume failed:", err);
        return null;
      }
    },

    getMicrophoneVolume: async () => {
      const robot = getRobot();
      if (isUnmounted() || !robot) return null;
      try {
        const v = await robot.getMicrophoneVolume();
        if (typeof v === "number")
          console.info("[volume] getMicrophoneVolume →", v);
        else
          console.debug("[volume] getMicrophoneVolume → null (DC not ready)");
        return v;
      } catch (err) {
        console.warn("[volume] getMicrophoneVolume failed:", err);
        return null;
      }
    },

    setMicrophoneVolume: async (volume: number) => {
      const robot = getRobot();
      if (isUnmounted() || !robot) return null;
      try {
        const applied = await robot.setMicrophoneVolume(volume);
        if (typeof applied === "number") {
          console.info(
            "[volume] setMicrophoneVolume",
            volume,
            "→ applied",
            applied,
          );
        } else {
          console.debug(
            "[volume] setMicrophoneVolume",
            volume,
            "→ null (DC not ready)",
          );
        }
        return applied;
      } catch (err) {
        console.warn("[volume] setMicrophoneVolume failed:", err);
        return null;
      }
    },

    getDaemonVersion: async () => {
      const robot = getRobot();
      if (isUnmounted() || !robot || typeof robot.getVersion !== "function") {
        return null;
      }
      try {
        const v = await robot.getVersion();
        return typeof v === "string" && v.length > 0 ? v : null;
      } catch (err) {
        console.warn("[engine] getDaemonVersion failed:", err);
        return null;
      }
    },

    startDaemonUpdate: (options) => {
      const robot = getRobot();
      // The daemon `start_update` command (reachy_mini#1208) is a plain
      // typed data-channel message. We send it via `sendRaw` rather than a
      // dedicated SDK helper so it works even on SDK builds that predate
      // the typed `startDaemonUpdate` method - the daemon understands the
      // wire shape regardless. Older daemons ignore it; callers gate the
      // call on a positive version check.
      if (isUnmounted() || !robot || typeof robot.sendRaw !== "function") {
        console.warn("[engine] startDaemonUpdate: engine not ready");
        return false;
      }
      try {
        const message: { type: "start_update"; pre_release?: boolean } = {
          type: "start_update",
        };
        if (options?.preRelease) message.pre_release = true;
        const ok = robot.sendRaw(message);
        if (!ok) console.warn("[engine] startDaemonUpdate: data channel not open");
        return ok;
      } catch (err) {
        console.warn("[engine] startDaemonUpdate failed:", err);
        return false;
      }
    },

    getMicLevel: () => getMicLevel(),

    playSound: (file: string) => {
      const robot = getRobot();
      if (isUnmounted() || !robot) {
        console.warn("[engine] playSound: engine not ready");
        return false;
      }
      try {
        // SDK returns false when the DataChannel isn't open. We
        // surface that to the caller so the UI can decide to skip
        // audible feedback (rather than hang on a silent failure).
        const ok = robot.playSound(file);
        if (!ok) console.warn("[engine] playSound: data channel not open");
        return ok;
      } catch (err) {
        console.warn("[engine] playSound failed:", err);
        return false;
      }
    },

    setHeadRpyDeg: (rollDeg: number, pitchDeg: number, yawDeg: number) => {
      const robot = getRobot();
      if (isUnmounted() || !robot) {
        // Manual head control surfaces (e.g. the joystick) call this
        // at 20 Hz while the user drags. Spamming a warn on every tick
        // before the engine boots would be noisy; stay silent.
        return false;
      }
      try {
        const ok = robot.setHeadRpyDeg(rollDeg, pitchDeg, yawDeg);
        return ok !== false; // SDK returns undefined on older builds
      } catch (err) {
        console.warn("[engine] setHeadRpyDeg failed:", err);
        return false;
      }
    },

    setBodyYawDeg: (yawDeg: number) => {
      const robot = getRobot();
      if (isUnmounted() || !robot) {
        // Same rationale as `setHeadRpyDeg`: the joystick's velocity
        // controller calls this on every tick when the head saturates
        // and the user keeps pushing. Stay silent before the engine
        // is mounted; the next viable tick will land.
        return false;
      }
      try {
        const ok = robot.setBodyYawDeg(yawDeg);
        return ok !== false; // SDK returns undefined on older builds
      } catch (err) {
        console.warn("[engine] setBodyYawDeg failed:", err);
        return false;
      }
    },

    subscribeLogs: (options) => {
      const robot = getRobot();
      // Older SDK builds (pre `feat/subscribe-logs-cmd`) ship without
      // `subscribeLogs`; degrade gracefully to a noop so the consumer's
      // hook stays mountable without runtime guards.
      if (
        isUnmounted() ||
        !robot ||
        typeof (robot as { subscribeLogs?: unknown }).subscribeLogs !==
          "function"
      ) {
        return () => {};
      }
      try {
        return robot.subscribeLogs(options);
      } catch (err) {
        console.warn("[engine] subscribeLogs failed:", err);
        return () => {};
      }
    },
  };

  return handle;
}
