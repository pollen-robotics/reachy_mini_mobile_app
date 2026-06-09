/**
 * Motion stack orchestrator.
 *
 * Encapsulates the three low-level motion controllers
 * (`PoseDispatcher` + `WobblerControl` + `AntennasControl`) behind
 * a single named API the engine can drive from FSM transitions and
 * lifecycle events. Replaces ~30 scattered `wobblerControl.X()` /
 * `antennasControl.X()` / `poseDispatcher.X()` call sites with a
 * focused vocabulary:
 *
 *   - Pipeline lifecycle: `startSession()`, `attachAiOutput(track)`,
 *     `stop({ glide, concurrentTask })`.
 *   - Per-FSM-event hooks: `onUserSpeak()`, `onAiSpeak()`,
 *     `onListening()`, `onProcessing()`, `onReconnecting()`. Each
 *     hook captures the "right thing for the motion stack to do in
 *     state X" so the engine's `onStatus` switch reads as a clean
 *     mapping `FSM state -> motion event`.
 *   - Visibility: `resumeAudio()` to wake the wobbler's
 *     AudioContext after a tab return (the antennas oscillator is
 *     time-based, no audio to resume).
 *
 * Why a single object
 * ───────────────────
 * 1. The three controllers must start / stop in a SPECIFIC order
 *    (sync stops first, then await concurrent work, then drop the
 *    pose dispatcher last). Centralising that order here means a
 *    new actor in the stack (a 4th controller, a new gate) is
 *    plumbed in once, not three or four times across the engine.
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
 *   pass it as `stop({ concurrentTask })` so the glide-to-neutral
 *   runs in parallel with the bridge close (saving ~bridge-close-ms
 *   off teardown latency).
 * - The audio level monitors (mic + AI side): those drive UI
 *   visuals and live in `audio-monitors-control.ts`. The
 *   `attachAiOutput` callback notifies the orchestrator about the
 *   AI track for the wobbler, but the engine separately calls
 *   `audioMonitors.startAi(track)` for the visualisation - the two
 *   consumers happen to share the same track.
 * - The tool-call handler: it lives one layer up because it also
 *   handles non-motion tools (`remember`, `forget`). It DOES feed
 *   `isPoseLocked` into the orchestrator via deps so the wobbler
 *   yields while a tool-driven pose is held.
 */

import { SESSION_TIMINGS } from "@/features/robot-session/timings";
import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";
import {
  type AntennasControl,
  createAntennasControl,
} from "./antennas-control";
import { createPoseDispatcher } from "./pose-dispatcher";
import {
  type WobblerControl,
  createWobblerControl,
} from "./wobbler-control";

const GLIDE_TO_NEUTRAL_MS = SESSION_TIMINGS.glideToNeutralMs;

export interface MotionOrchestratorDeps {
  /** Live SDK accessor. Forwarded to the three underlying
   *  controllers; they all bail out (no-op) when null. */
  getRobot: () => ReachyMiniInstance | null;
  /** Forwarded to the wobbler. True while a tool-call head pose
   *  is "held" by the tool-call handler's restore timer; the
   *  wobbler skips its 30 Hz writes so the head stays where the
   *  model put it. */
  isPoseLocked: () => boolean;
  /** Forwarded to the wobbler + antennas. True while a streamed
   *  choreography is playing; both controllers yield so the
   *  recorded frames don't fight live offsets. */
  isMovePlaying: () => boolean;
  /** Forwarded to the pose dispatcher's `recordSend` hook so the
   *  DC-health monitor can track the actual outbound rate from
   *  the only writer to the head + antennas data channel. The
   *  `where` tag identifies which call site reported the send. */
  recordSend: (ok: boolean, where: string) => void;
}

export interface MotionStopOptions {
  /** When `true`, the wobbler + antennas play a 700 ms cubic
   *  ease-out to neutral after the sync stops. When `false`, no
   *  glide (typically the power-off path: gotoSleep is about to
   *  own the head + antennas trajectory and any glide frame would
   *  just fight the daemon-side sleep animation). */
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
   *  running tick), then start the antennas oscillator. The
   *  wobbler waits for its AI audio track via `attachAiOutput`. */
  startSession(): void;
  /** Bind the assistant audio track to the wobbler. Called
   *  from the realtime bridge's `onOutputTrack` callback once the
   *  inbound track lands. Idempotent across reconnects (the
   *  wobbler tears its previous instance down on `start`). */
  attachAiOutput(assistantTrack: MediaStreamTrack): void;
  /** Tear the motion stack down. See `MotionStopOptions` for the
   *  glide / concurrent-task semantics. */
  stop(opts: MotionStopOptions): Promise<void>;

  // ─── Per-FSM-event hooks ─────────────────────────────────────────
  //
  // Each hook captures the "right thing for the motion stack to do
  // when the FSM lands in state X". The engine's `onStatus` switch
  // simply calls the matching hook instead of touching the
  // individual controllers.

  /** Barge-in: user started talking. Reset the wobbler's head
   *  baseline and freeze the antennas at their current angle so
   *  the robot looks "attentive" rather than oscillating idly. */
  onUserSpeak(): void;
  /** Reachy is generating speech audio. Resume the antennas
   *  oscillator if it was frozen. */
  onAiSpeak(): void;
  /** Backend is "thinking" between user-speak and ai-speak.
   *  Resume the antennas oscillator so the robot doesn't look
   *  frozen mid-turn. */
  onProcessing(): void;
  /** Back to listening: the AI response is fully done (silence
   *  detected on the AI track). Resume the antennas oscillator. */
  onListening(): void;
  /** Realtime bridge is rebuilding its backend session. The wobbler's
   *  input track is about to go away, so stop it; freeze the
   *  antennas so the orb doesn't keep oscillating during the
   *  reconnect spinner. */
  onReconnecting(): void;

  /** Wake the wobbler's private AudioContext after a visibility
   *  return (Safari / iOS aggressively suspend audio contexts in
   *  hidden tabs). The antennas oscillator is purely time-based,
   *  no audio context to resume. Safe to call when no wobbler is
   *  active. */
  resumeAudio(): void;
}

export function createMotionOrchestrator(
  deps: MotionOrchestratorDeps,
): MotionOrchestrator {
  const poseDispatcher = createPoseDispatcher({
    getRobot: deps.getRobot,
    recordSend: deps.recordSend,
  });
  const wobblerControl: WobblerControl = createWobblerControl({
    getRobot: deps.getRobot,
    isPoseLocked: deps.isPoseLocked,
    isMovePlaying: deps.isMovePlaying,
    poseDispatcher,
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
    },
    attachAiOutput(assistantTrack) {
      wobblerControl.start(assistantTrack);
    },
    async stop({ glide, concurrentTask }) {
      // Order matters: kill the 30 Hz pose streams synchronously
      // BEFORE any await, otherwise the wobbler / antennas keep
      // ticking through `concurrentTask` and can race the
      // trajectory gate. A late wobbler / antennas write is enough
      // to wedge the Dynamixel bus on the way out.
      wobblerControl.stop();
      antennasControl.stop();

      if (glide) {
        // Gentle exit: ease the head + antennas to neutral in
        // parallel with `concurrentTask` (typically the realtime
        // bridge close) so the iframe / next conversation takes
        // over a calmly-posed robot. The glide flushes its final
        // neutral frame through the dispatcher, so we stop the
        // dispatcher AFTER it lands.
        const glidePromise = Promise.all([
          wobblerControl.glideToNeutral(GLIDE_TO_NEUTRAL_MS),
          antennasControl.glideToNeutral(GLIDE_TO_NEUTRAL_MS),
        ]);
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
      wobblerControl.reset();
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
      wobblerControl.stop();
      antennasControl.freeze();
    },
    resumeAudio() {
      wobblerControl.resumeAudio();
    },
  };
}
