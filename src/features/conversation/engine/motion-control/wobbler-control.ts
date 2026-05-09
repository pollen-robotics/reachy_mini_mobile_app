/**
 * Head-wobbler controller.
 *
 * Wraps `HeadWobbler` (the low-level audio-driven head animator under
 * `motion/head-wobbler.ts`) with engine-level coordination:
 *
 *   - Lazy instantiation per session.
 *   - Gated routing of `setHead` writes that yield to:
 *       * tool-call head poses ("look up", "look right", …),
 *       * streamed choreographies ("dance"),
 *       * daemon-side trajectories (wake_up, goto_sleep).
 *   - Pose updates flow through `PoseDispatcher` (NOT directly to
 *     the SDK) so head + antennas are coalesced into one
 *     `set_full_target` per dispatcher tick. This halves the data-
 *     channel message rate and aligns the two axes temporally.
 *   - Tracking of the last-actually-pushed pose so `glideToNeutral`
 *     can ease the head smoothly back to (0, 0, 0) instead of
 *     snapping.
 *
 * The controller is recreated on every `start(track)` because the
 * underlying analyser is bound to a specific assistant audio track
 * (one OpenAI Realtime session = one track). Calling `start()` while
 * already running tears down the previous instance first.
 */

import { HeadWobbler } from "../../motion/head-wobbler";
import { isTrajectoryPlaying } from "../trajectoryGate";
import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";
import type { PoseDispatcher } from "./pose-dispatcher";

export interface WobblerControlDeps {
  /** Live SDK accessor. The control bails out (no-op) when null. */
  getRobot: () => ReachyMiniInstance | null;
  /** True while a tool-driven head pose is "held" (the
   *  tool-call-handler still owns the head until its restore
   *  timer expires). The wobbler skips its 30 Hz writes for the
   *  duration so the head stays where the model put it. */
  isPoseLocked: () => boolean;
  /** True while a streamed choreography is playing. The wobbler
   *  yields so the recorded frames don't fight the live offsets. */
  isMovePlaying: () => boolean;
  /** Pose dispatcher to push `setHead` updates into. The
   *  dispatcher coalesces with antennas updates and runs its own
   *  fixed-rate tick. */
  poseDispatcher: PoseDispatcher;
}

export interface WobblerControl {
  /** Spawn a fresh wobbler bound to `assistantTrack`. Replaces any
   *  existing instance. No-op if the SDK isn't connected yet. */
  start: (assistantTrack: MediaStreamTrack) => void;
  /** Stop the wobbler without sending any final frame. The caller
   *  is responsible for landing the head (typically via
   *  `glideToNeutral()`). */
  stop: () => void;
  /** Forward to the underlying wobbler's `reset()` if any. Safe
   *  to call before `start()`. */
  reset: () => void;
  /** Wake the wobbler's private AudioContext after a visibility
   *  return. Some browsers (notably Safari / iOS) suspend audio
   *  contexts when the tab is backgrounded; this kicks them back
   *  alive. No-op if no wobbler is currently active. */
  resumeAudio: () => void;
  /**
   * Smoothly ease the head back to its neutral (0, 0, 0) home
   * pose over `durationMs`. Resolves once the (0, 0, 0) frame
   * has been pushed to the dispatcher. The dispatcher's flush
   * eventually emits the final `set_full_target` on the bus.
   *
   * Call this AFTER `stop()` in shutdown paths (stopConversation,
   * release, …) for a calm, animated landing rather than a snap.
   * 30Hz cubic ease-out from the last-actually-sent pose to (0, 0, 0).
   */
  glideToNeutral: (durationMs: number) => Promise<void>;
}

/** Frame rate of the easing animation, in Hz. */
const GLIDE_FPS = 30;
/** Threshold (deg) below which a position is considered "already
 *  neutral" - we skip the animation entirely to avoid a tiny visible
 *  kick on the bus when the head is already at rest. */
const NEUTRAL_EPSILON_DEG = 0.05;

export function createWobblerControl(
  deps: WobblerControlDeps,
): WobblerControl {
  let wobbler: HeadWobbler | null = null;
  // Last value we ACTUALLY pushed to the dispatcher. Recorded
  // inside the gated callback so the snapshot reflects the robot's
  // current command (gated frames don't reach the dispatcher, so
  // they don't change the pose, so we don't track them).
  let lastRoll = 0;
  let lastPitch = 0;
  let lastYaw = 0;

  const start = (assistantTrack: MediaStreamTrack): void => {
    const robot = deps.getRobot();
    if (!robot) return;

    wobbler?.stopWithoutFinalFrame();
    wobbler = new HeadWobbler({
      track: assistantTrack,
      onOffsets: ({ roll, pitch, yaw }) => {
        // Don't fight an active tool-driven gesture or a streamed
        // move: those own the head while they run.
        if (deps.isPoseLocked()) return;
        if (deps.isMovePlaying()) return;
        // Same for daemon-side wake_up / goto_sleep trajectories:
        // they own the head for ~2 s and a 30 Hz setHeadPose stream
        // would freeze the animation mid-flight.
        if (isTrajectoryPlaying()) return;
        // Push to the dispatcher rather than calling
        // `robot.setHeadRpyDeg` directly: the dispatcher batches
        // with antennas and rate-limits the data channel.
        deps.poseDispatcher.setHead(roll, pitch, yaw);
        lastRoll = roll;
        lastPitch = pitch;
        lastYaw = yaw;
      },
    });
    wobbler.start();
  };

  const stop = (): void => {
    // `stopWithoutFinalFrame()` drops the wobbler's tick timer +
    // tears down the AudioContext but does NOT push a (0, 0, 0)
    // frame. The caller is expected to follow up with
    // `glideToNeutral()` so the head lands on a known calm pose
    // through the dispatcher's coalescing path.
    wobbler?.stopWithoutFinalFrame();
    wobbler = null;
  };

  const reset = (): void => {
    wobbler?.reset();
  };

  const resumeAudio = (): void => {
    wobbler?.resumeAudio();
  };

  const glideToNeutral = async (durationMs: number): Promise<void> => {
    if (!deps.getRobot()) return;
    const startRoll = lastRoll;
    const startPitch = lastPitch;
    const startYaw = lastYaw;
    if (
      Math.abs(startRoll) < NEUTRAL_EPSILON_DEG &&
      Math.abs(startPitch) < NEUTRAL_EPSILON_DEG &&
      Math.abs(startYaw) < NEUTRAL_EPSILON_DEG
    ) {
      // Already neutral; just push one explicit (0, 0, 0) so the
      // dispatcher's tracked pose is exact.
      deps.poseDispatcher.setHead(0, 0, 0);
      lastRoll = 0;
      lastPitch = 0;
      lastYaw = 0;
      return;
    }
    const frameMs = 1000 / GLIDE_FPS;
    const totalFrames = Math.max(2, Math.ceil(durationMs / frameMs));
    for (let i = 1; i <= totalFrames; i++) {
      const t = i / totalFrames;
      // Ease-out cubic: starts fast, settles softly.
      const e = 1 - Math.pow(1 - t, 3);
      const roll = startRoll * (1 - e);
      const pitch = startPitch * (1 - e);
      const yaw = startYaw * (1 - e);
      deps.poseDispatcher.setHead(roll, pitch, yaw);
      lastRoll = roll;
      lastPitch = pitch;
      lastYaw = yaw;
      await new Promise((resolve) => setTimeout(resolve, frameMs));
    }
    // Belt-and-braces final landing: easing math floors to 0 but a
    // stray rounding error could leave a sub-degree residue. Push
    // an exact (0, 0, 0) and force-flush so the daemon-side tracking
    // is clean for the next motor-mode switch.
    deps.poseDispatcher.setHead(0, 0, 0);
    deps.poseDispatcher.flushNow();
    lastRoll = 0;
    lastPitch = 0;
    lastYaw = 0;
  };

  return { start, stop, reset, resumeAudio, glideToNeutral };
}
