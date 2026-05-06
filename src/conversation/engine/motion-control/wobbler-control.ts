/**
 * Head-wobbler controller.
 *
 * Wraps `HeadWobbler` (the low-level audio-driven head animator under
 * `motion/head-wobbler.ts`) with engine-level coordination:
 *
 *   - Lazy instantiation per session.
 *   - Gated `setHeadRpyDeg` writes that yield to:
 *       * tool-call head poses ("look up", "look right", …),
 *       * streamed choreographies ("dance"),
 *       * daemon-side trajectories (wake_up, goto_sleep).
 *   - Send-result reporting back to the data-channel health monitor
 *     so a flaky link gets surfaced rather than moving silently.
 *   - Tracking of the last-actually-sent pose so a follow-up
 *     `glideToNeutral()` can ease the head smoothly back to (0, 0, 0)
 *     instead of snapping.
 *
 * The controller is recreated on every `start(track)` because the
 * underlying analyser is bound to a specific assistant audio track
 * (one OpenAI Realtime session = one track). Calling `start()` while
 * already running tears down the previous instance first.
 */

import { HeadWobbler } from "../../motion/head-wobbler";
import { isTrajectoryPlaying } from "../trajectoryGate";
import type { ReachyMiniInstance } from "../globals";

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
  /** Forward the outcome of every `setHeadRpyDeg` to the engine's
   *  data-channel health monitor. */
  recordSend: (ok: boolean, where: string) => void;
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
   * has been sent. Bypasses the pose-lock / move / trajectory
   * gate so the landing is guaranteed even mid-cleanup.
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
  // Last value we ACTUALLY sent through `setHeadRpyDeg`. Recorded
  // inside the gated callback so the snapshot reflects the robot's
  // current command (gated frames don't reach the daemon, so they
  // don't change the pose, so we don't track them).
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
        // Offsets are in degrees; we push them as absolute target
        // poses around the neutral head position (no base pose is
        // preserved, which keeps the motion unambiguously around
        // "looking forward").
        const ok = deps.getRobot()?.setHeadRpyDeg(roll, pitch, yaw) ?? false;
        if (ok) {
          lastRoll = roll;
          lastPitch = pitch;
          lastYaw = yaw;
        }
        deps.recordSend(ok, "wobbler");
      },
    });
    wobbler.start();
  };

  const stop = (): void => {
    // `stopWithoutFinalFrame()` drops the wobbler's tick timer +
    // tears down the AudioContext but does NOT push a (0, 0, 0)
    // frame on the bus. The caller is expected to follow up with
    // `glideToNeutral()` (or, if it really wants a snap, just
    // `setHeadRpyDeg(0, 0, 0)` directly). This avoids a single-
    // frame jump from the last animated pose straight to neutral,
    // which the daemon executes in one Dynamixel servo tick - a
    // visibly abrupt motion AND an audible bus burst on the
    // physical robot.
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
    const robot = deps.getRobot();
    if (!robot) return;
    const startRoll = lastRoll;
    const startPitch = lastPitch;
    const startYaw = lastYaw;
    if (
      Math.abs(startRoll) < NEUTRAL_EPSILON_DEG &&
      Math.abs(startPitch) < NEUTRAL_EPSILON_DEG &&
      Math.abs(startYaw) < NEUTRAL_EPSILON_DEG
    ) {
      // Already neutral; just push one explicit (0, 0, 0) so the
      // daemon's tracked pose is exact.
      const ok = robot.setHeadRpyDeg(0, 0, 0);
      deps.recordSend(ok, "wobbler-glide");
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
      const ok =
        deps.getRobot()?.setHeadRpyDeg(roll, pitch, yaw) ?? false;
      if (ok) {
        lastRoll = roll;
        lastPitch = pitch;
        lastYaw = yaw;
      }
      deps.recordSend(ok, "wobbler-glide");
      await new Promise((resolve) => setTimeout(resolve, frameMs));
    }
    // Belt-and-braces final landing: easing math floors to 0 but a
    // stray rounding error could leave a sub-degree residue. Push
    // an exact (0, 0, 0) so the daemon-side tracking is clean for
    // the next motor-mode switch.
    const ok = deps.getRobot()?.setHeadRpyDeg(0, 0, 0) ?? false;
    if (ok) {
      lastRoll = 0;
      lastPitch = 0;
      lastYaw = 0;
    }
    deps.recordSend(ok, "wobbler-glide");
  };

  return { start, stop, reset, resumeAudio, glideToNeutral };
}
