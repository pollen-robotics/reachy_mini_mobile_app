/**
 * Motion stack orchestrator.
 *
 * Encapsulates the three low-level motion controllers
 * (`PoseDispatcher` + `DaemonHeadControl` + `AntennasControl`) behind
 * a single named API the engine can drive from FSM transitions and
 * lifecycle events. Replaces ~30 scattered `daemonHead.X()` /
 * `antennasControl.X()` / `poseDispatcher.X()` call sites with a
 * focused vocabulary:
 *
 *   - Pipeline lifecycle: `startSession()`,
 *     `stop({ glide, concurrentTask })`.
 *   - Per-FSM-event hooks: `onUserSpeak()`, `onAiSpeak()`,
 *     `onListening()`, `onProcessing()`, `onReconnecting()`. Each
 *     hook captures the "right thing for the motion stack to do in
 *     state X" so the engine's `onStatus` switch reads as a clean
 *     mapping `FSM state -> motion event`.
 *
 * Who animates the head
 * ─────────────────────
 * The daemon does, not us. It owns both the face tracking and the
 * speech wobble; the app only turns them on and off through
 * `DaemonHeadControl`. The reason is the order the daemon composes the
 * head target in: app pose, blended toward the tracking aim, THEN the
 * speech offsets. At full tracking weight the app's pose writes are
 * dropped entirely, so an app-side wobbler would be invisible - and
 * the daemon's wobble is PTS-aligned with what the speaker actually
 * plays, which the app could never match through a jitter buffer. The
 * app keeps the antennas, which tracking never touches.
 *
 * Why a single object
 * ───────────────────
 * 1. The three controllers must start / stop in a SPECIFIC order
 *    (hand the head back to the app first, sync stops next, then
 *    await concurrent work, then drop the pose dispatcher last).
 *    Centralising that order here means a new actor in the stack (a
 *    4th controller, a new gate) is plumbed in once, not three or
 *    four times across the engine.
 *
 * 2. Behaviour per FSM state used to be scattered: 4 places in the
 *    engine wrote pairs like `wobbler.reset() + antennas.freeze()`
 *    or `antennas.resume()`. A future change to "what user-speak
 *    does on the motion side" had to find and update each pair.
 *    Now there's exactly one `onUserSpeak()` implementation.
 *
 * 3. Tests can drive the orchestrator with a fake SDK and assert
 *    "after onUserSpeak() the dispatcher saw a setAntennas(0,0)"
 *    without spinning up the FSM, realtime backend, or background-resilience.
 *
 * What the orchestrator does NOT own
 * ──────────────────────────────────
 * - The realtime bridge close: that's external slow work. Callers
 *   pass it as `stop({ concurrentTask })` so the landing to neutral
 *   runs in parallel with the bridge close (saving ~bridge-close-ms
 *   off teardown latency).
 * - The audio level monitors (mic + AI side): those drive UI
 *   visuals and live in `audio-monitors-control.ts`. Nothing on the
 *   motion side needs the assistant track any more, since the wobble
 *   is derived on the robot from the audio it receives.
 * - The tool-call handler: it lives one layer up because it also
 *   handles non-motion tools (`remember`, `forget`). It DOES feed
 *   `isPoseLocked` into the orchestrator via deps so face tracking
 *   parks while a tool-driven pose is held - otherwise the daemon
 *   would discard that pose and "look up" would do nothing.
 */

import { SESSION_TIMINGS } from "@/features/robot-session/timings";
import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";
import {
  type AntennasControl,
  createAntennasControl,
} from "./antennas-control";
import {
  type DaemonHeadControl,
  createDaemonHeadControl,
} from "./daemon-head-control";
import { createPoseDispatcher } from "./pose-dispatcher";

const GLIDE_TO_NEUTRAL_MS = SESSION_TIMINGS.glideToNeutralMs;

export interface MotionOrchestratorDeps {
  /** Live SDK accessor. Forwarded to the three underlying
   *  controllers; they all bail out (no-op) when null. */
  getRobot: () => ReachyMiniInstance | null;
  /** Forwarded to the daemon head control. True while a tool-call
   *  head pose is "held" by the tool-call handler's restore timer;
   *  face tracking parks for the duration so the daemon stops
   *  discarding the app's pose and the head stays where the model
   *  put it. */
  isPoseLocked: () => boolean;
  /** Forwarded to the daemon head control + antennas. True while a
   *  streamed choreography is playing; tracking parks and the
   *  antennas yield so the recorded frames reach the joints. */
  isMovePlaying: () => boolean;
  /** Forwarded to the pose dispatcher's `recordSend` hook so the
   *  DC-health monitor can track the actual outbound rate from
   *  the only writer to the head + antennas data channel. The
   *  `where` tag identifies which call site reported the send. */
  recordSend: (ok: boolean, where: string) => void;
}

export interface MotionStopOptions {
  /** When `true`, the head is eased to neutral daemon-side and the
   *  antennas play their 700 ms cubic ease-out. When `false`, no
   *  landing at all (typically the power-off path: gotoSleep is about
   *  to own the head + antennas trajectory, and both our landing and
   *  its own would be refused as a second concurrent move anyway). */
  glide: boolean;
  /** Optional awaitable the orchestrator races AGAINST the glide.
   *  Typical use: pass `realtimeBridge.close()` so the bridge tears
   *  the backend session down in parallel with the head ease-out
   *  rather than sequentially after it. The orchestrator does NOT
   *  inspect the task - any failure throws back to the caller. */
  concurrentTask?: Promise<unknown>;
}

export interface MotionOrchestrator {
  /** Bring up the motion stack for a fresh conversation: start the
   *  pose dispatcher (so the controllers' first frames land in a
   *  running tick), start the antennas oscillator, then hand the head
   *  to the daemon (face tracking + speech wobble). */
  startSession(): void;
  /** Tear the motion stack down. See `MotionStopOptions` for the
   *  glide / concurrent-task semantics. */
  stop(opts: MotionStopOptions): Promise<void>;

  // ─── Per-FSM-event hooks ─────────────────────────────────────────
  //
  // Each hook captures the "right thing for the motion stack to do
  // when the FSM lands in state X". The engine's `onStatus` switch
  // simply calls the matching hook instead of touching the
  // individual controllers.

  /** Barge-in: user started talking. Zero the daemon's speech
   *  offsets, which the cut assistant turn would otherwise leave
   *  applied, and freeze the antennas at their current angle so the
   *  robot looks "attentive" rather than oscillating idly. */
  onUserSpeak(): void;
  /** Reachy is generating speech audio. Resume the antennas
   *  oscillator if it was frozen. The head needs nothing: the daemon
   *  is already wobbling it from the audio it plays. */
  onAiSpeak(): void;
  /** Backend is "thinking" between user-speak and ai-speak.
   *  Resume the antennas oscillator so the robot doesn't look
   *  frozen mid-turn. */
  onProcessing(): void;
  /** Back to listening: the AI response is fully done (silence
   *  detected on the AI track). Resume the antennas oscillator. */
  onListening(): void;
  /** Realtime bridge is rebuilding its backend session. The assistant
   *  audio is about to stop mid-flight, so zero the speech offsets;
   *  freeze the antennas so the orb doesn't keep oscillating during
   *  the reconnect spinner. Face tracking stays on: the robot keeps
   *  watching the user while the session comes back. */
  onReconnecting(): void;

  /** Gate / ungate the pose dispatcher's network writes while the
   *  transport is degraded (`iceStateChange === 'disconnected' |
   *  'failed'`, `networkOffline`). Gated writes stay staged so the
   *  first tick after ungating resumes with the freshest pose.
   *  Delegates to `PoseDispatcher.setSendGate`. Idempotent. */
  setSendGate(gate: boolean): void;
  /** Whether the pose dispatcher is currently gated via
   *  `setSendGate(true)`. */
  isGated(): boolean;
}

export function createMotionOrchestrator(
  deps: MotionOrchestratorDeps,
): MotionOrchestrator {
  const poseDispatcher = createPoseDispatcher({
    getRobot: deps.getRobot,
    recordSend: deps.recordSend,
  });
  const daemonHead: DaemonHeadControl = createDaemonHeadControl({
    getRobot: deps.getRobot,
    isPoseLocked: deps.isPoseLocked,
    isMovePlaying: deps.isMovePlaying,
    recordSend: deps.recordSend,
  });
  const antennasControl: AntennasControl = createAntennasControl({
    getRobot: deps.getRobot,
    isMovePlaying: deps.isMovePlaying,
    poseDispatcher,
  });

  return {
    startSession() {
      // Order matters: bring the dispatcher up BEFORE the wobbler /
      // antennas start pushing into it - otherwise the first ~50 ms
      // of pose updates would be staged but never flushed (no tick
      // timer running yet). Idempotent: a re-acquire after a release
      // lands here too with the dispatcher already running, no harm.
      poseDispatcher.start();
      antennasControl.start();
      // Last, so the daemon starts aiming the head only once our own
      // channels are live and can be parked again on the way out.
      daemonHead.enable();
    },
    async stop({ glide, concurrentTask }) {
      // Order matters, and the first step is the subtle one: hand the
      // head back to the app BEFORE anything tries to move it. While
      // tracking holds full weight the daemon discards every head
      // target it receives, including the frames its own goto player
      // writes, so a landing requested first would move nothing and
      // the head would jump the moment tracking went away.
      daemonHead.disable();
      // Then kill the 30 Hz antennas stream synchronously BEFORE any
      // await, otherwise it keeps ticking through `concurrentTask` and
      // can race the trajectory gate. A late antennas write is enough
      // to wedge the Dynamixel bus on the way out.
      antennasControl.stop();

      if (glide) {
        // Gentle exit: ease the head + antennas to neutral in
        // parallel with `concurrentTask` (typically the realtime
        // bridge close) so the iframe / next conversation takes
        // over a calmly-posed robot. The head lands daemon-side at
        // 100 Hz from wherever tracking left it, immune to the
        // data-channel cadence; the antennas glide flushes its final
        // frame through the dispatcher, so we stop the dispatcher
        // AFTER it lands.
        daemonHead.gotoNeutral(GLIDE_TO_NEUTRAL_MS);
        const glidePromise = antennasControl.glideToNeutral(
          GLIDE_TO_NEUTRAL_MS,
        );
        if (concurrentTask) await concurrentTask;
        await glidePromise;
      } else if (concurrentTask) {
        // Power-off path (or any caller that opts out of the
        // glide): just wait for the concurrent task before
        // dropping the dispatcher.
        await concurrentTask;
      }
      poseDispatcher.stop();
    },
    onUserSpeak() {
      daemonHead.clearSpeechOffsets();
      antennasControl.freeze();
    },
    onAiSpeak() {
      antennasControl.resume();
    },
    onProcessing() {
      antennasControl.resume();
    },
    onListening() {
      antennasControl.resume();
    },
    onReconnecting() {
      daemonHead.clearSpeechOffsets();
      antennasControl.freeze();
    },
    setSendGate(gate) {
      poseDispatcher.setSendGate(gate);
    },
    isGated() {
      return poseDispatcher.isGated();
    },
  };
}
