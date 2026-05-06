/**
 * Antennas oscillator controller.
 *
 * Wraps `AntennasOscillator` (the low-level idle ear breather under
 * `motion/antennas.ts`) with engine-level coordination:
 *
 *   - Lazy instantiation per session.
 *   - Gated `setAntennasDeg` writes that yield to:
 *       * streamed choreographies (the move owns the antennas),
 *       * daemon-side trajectories (wake_up, goto_sleep also drive
 *         the antennas, and we don't want our 0.5 Hz sine fighting
 *         the recorded keyframes).
 *   - Send-result reporting back to the data-channel health monitor.
 *   - `freeze()` / `resume()` proxies forwarded straight through so
 *     the engine can pause the oscillator while the user speaks.
 *   - Tracking of the last-actually-sent pose so a follow-up
 *     `glideToNeutral()` can ease the antennas smoothly back to
 *     (0, 0) instead of snapping.
 *
 * Recreated on every `start()` so a fresh session begins from a
 * neutral phase.
 */

import { AntennasOscillator } from "../../motion/antennas";
import { isTrajectoryPlaying } from "../trajectoryGate";
import type { ReachyMiniInstance } from "../globals";

export interface AntennasControlDeps {
  /** Live SDK accessor. The control bails out when null. */
  getRobot: () => ReachyMiniInstance | null;
  /** True while a streamed choreography is playing. The oscillator
   *  yields so the recorded antenna frames don't fight our sine. */
  isMovePlaying: () => boolean;
  /** Forward the outcome of every `setAntennasDeg` to the engine's
   *  data-channel health monitor. */
  recordSend: (ok: boolean, where: string) => void;
}

export interface AntennasControl {
  /** Spawn a fresh oscillator. Replaces any existing instance. */
  start: () => void;
  /** Stop the oscillator without sending any final frame. The
   *  caller is responsible for landing the antennas (typically
   *  via `glideToNeutral()`). */
  stop: () => void;
  /** Pause the oscillator (held value, no writes). */
  freeze: () => void;
  /** Resume the oscillator from where it was frozen. */
  resume: () => void;
  /**
   * Smoothly ease the antennas back to their neutral (0, 0) home
   * pose over `durationMs`. Resolves once the (0, 0) frame has
   * been sent. Bypasses the move / trajectory gate so the landing
   * is guaranteed even mid-cleanup.
   *
   * Call this AFTER `stop()` in shutdown paths (stopConversation,
   * release, …) for a calm, animated landing rather than a snap.
   * 30Hz cubic ease-out from the last-actually-sent pose to (0, 0).
   */
  glideToNeutral: (durationMs: number) => Promise<void>;
}

/** Frame rate of the easing animation, in Hz. */
const GLIDE_FPS = 30;
/** Threshold (deg) below which a position is considered "already
 *  neutral" - we skip the animation entirely to avoid a tiny visible
 *  kick on the bus when the antennas are already at rest. */
const NEUTRAL_EPSILON_DEG = 0.05;

export function createAntennasControl(
  deps: AntennasControlDeps,
): AntennasControl {
  let antennas: AntennasOscillator | null = null;
  // Last value we ACTUALLY sent through `setAntennasDeg`. We record
  // it inside the gated callback so the snapshot reflects the
  // robot's current command (gated frames don't reach the daemon,
  // so they don't change the pose, so we don't track them).
  let lastRight = 0;
  let lastLeft = 0;

  const start = (): void => {
    const robot = deps.getRobot();
    if (!robot) return;
    antennas?.stopWithoutFinalFrame();
    antennas = new AntennasOscillator({
      onAntennas: (right, left) => {
        if (deps.isMovePlaying()) return;
        if (isTrajectoryPlaying()) return;
        const ok = deps.getRobot()?.setAntennasDeg(right, left) ?? false;
        if (ok) {
          lastRight = right;
          lastLeft = left;
        }
        deps.recordSend(ok, "antennas");
      },
    });
    antennas.start();
  };

  const stop = (): void => {
    // `stopWithoutFinalFrame()` drops the oscillator's tick timer
    // but does NOT push a (0, 0) frame on the bus. The caller is
    // expected to follow up with `glideToNeutral()` (or, if it
    // really wants a snap, just `setAntennasDeg(0, 0)` directly).
    // This avoids a single-frame jump from the last animated pose
    // straight to neutral, which the daemon executes in one
    // Dynamixel servo tick - a visibly abrupt motion AND an audible
    // bus burst on the physical robot.
    antennas?.stopWithoutFinalFrame();
    antennas = null;
  };

  const freeze = (): void => {
    antennas?.freeze();
  };

  const resume = (): void => {
    antennas?.resume();
  };

  const glideToNeutral = async (durationMs: number): Promise<void> => {
    const robot = deps.getRobot();
    if (!robot) return;
    const startRight = lastRight;
    const startLeft = lastLeft;
    if (
      Math.abs(startRight) < NEUTRAL_EPSILON_DEG &&
      Math.abs(startLeft) < NEUTRAL_EPSILON_DEG
    ) {
      // Already neutral; just push one explicit (0, 0) so the
      // daemon's tracked pose is exact.
      const ok = robot.setAntennasDeg(0, 0);
      deps.recordSend(ok, "antennas-glide");
      lastRight = 0;
      lastLeft = 0;
      return;
    }
    const frameMs = 1000 / GLIDE_FPS;
    const totalFrames = Math.max(2, Math.ceil(durationMs / frameMs));
    for (let i = 1; i <= totalFrames; i++) {
      const t = i / totalFrames;
      // Ease-out cubic: starts fast, settles softly.
      const e = 1 - Math.pow(1 - t, 3);
      const right = startRight * (1 - e);
      const left = startLeft * (1 - e);
      const ok = deps.getRobot()?.setAntennasDeg(right, left) ?? false;
      if (ok) {
        lastRight = right;
        lastLeft = left;
      }
      deps.recordSend(ok, "antennas-glide");
      await new Promise((resolve) => setTimeout(resolve, frameMs));
    }
    // Belt-and-braces final landing: the math above floors to 0
    // through the easing, but a stray rounding error could leave a
    // sub-degree residue. Push an exact (0, 0) so the daemon-side
    // tracking is clean for the next motor-mode switch.
    const ok = deps.getRobot()?.setAntennasDeg(0, 0) ?? false;
    if (ok) {
      lastRight = 0;
      lastLeft = 0;
    }
    deps.recordSend(ok, "antennas-glide");
  };

  return { start, stop, freeze, resume, glideToNeutral };
}
