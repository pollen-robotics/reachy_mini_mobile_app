/**
 * Return-to-base helper for the first wake-up wizard.
 *
 * Principle: every emotion in the wizard ends by sending the robot back to its
 * neutral "end of wake-up" pose - the closing move included. Keeping this in
 * one place means every step shares the exact same base pose and timing, so the
 * robot never lingers on the last frame of an emote between steps.
 *
 * IMPORTANT (Wi-Fi): the return MUST be a single daemon-side `goto_target`, not
 * a stream of `set_full_target` frames. A recorded emote plays entirely on the
 * daemon (100 Hz, transport-independent), but streamed pose targets ride the
 * WebRTC data channel one by one - and on Wi-Fi their jitter/latency makes the
 * robot judder ("flicker") on the way back to neutral. USB and the simulator
 * have near-zero latency, so the same stream looks smooth there, which is why
 * the flicker only ever showed up over Wi-Fi. `goto_target` hands the whole
 * interpolation to the daemon, so the return is smooth regardless of transport.
 */

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';

/**
 * Delay (ms) to wait past a recorded move's end before resetting. While a move
 * plays the daemon owns the motors and drops pose commands, so a reset fired
 * mid-move is a no-op.
 *
 * The margin has to absorb the dispatch latency too: our JS timer starts when we
 * *call* `playRecordedMove`, but the move only starts on the robot a few hundred
 * ms later (data-channel round-trip + daemon scheduling), so its real end is
 * shifted past `FINISH_MOVE_MS`. 300 ms was too tight (the closing `welcoming2`
 * reset landed mid-move and got dropped, leaving the robot off-neutral); 800 ms
 * clears the move + latency comfortably. Only the closing sequence uses this;
 * each step's own reveal timer already carries its buffer.
 */
export const RESET_AFTER_MOVE_MS = 800;

/**
 * The neutral goto is a no-op while a recorded move is still running: it goes
 * through the daemon's move player, which drops it on `is_move_running` ("Ignoring
 * play_move request: another move is running"). So *when* we fire it matters.
 *
 * Preferred path (see `useStepEmotes`): fire it exactly once, the instant the
 * move actually ends - detected from the daemon's `is_move_running` going false
 * on the pushed pose stream. That edge is authoritative, so a single goto lands
 * cleanly (`retries: 0`); no salvo needed.
 *
 * Blind path (the closing sequence, which fires on a fixed timer rather than the
 * move-end edge): dispatch latency can push the real move end past our JS timer,
 * so a lone goto risks landing mid-move and getting dropped - leaving the robot
 * on the move's last (expressive) frame. There we re-issue the (idempotent) goto
 * a few times over a short tail: the first attempt that lands after the body is
 * released wins; later ones are no-ops (dropped mid-goto, or a zero-distance goto
 * once already at neutral). Sized to cover ~1.6 s of latency variance. Each
 * attempt is a single fire-and-forget command, NOT a streamed frame, so the
 * motion is one daemon-side interpolation and stays smooth on Wi-Fi.
 */
const RESET_RETRY_COUNT = 4;
const RESET_RETRY_INTERVAL_MS = 400;

/** Duration (s) of the daemon-side interpolation back to neutral. */
const RESET_GOTO_DURATION_S = 0.5;

/** Margin (ms) for data-channel dispatch jitter between two commands: the
 *  reset goto and a follow-up move ride the same channel, so their latencies
 *  mostly cancel out; this only absorbs the variance between the two sends. */
const RESET_DISPATCH_JITTER_MS = 250;

/**
 * How long (ms) after dispatching a reset goto it can still be driving the
 * motors: the goto's own daemon-side interpolation plus dispatch jitter.
 *
 * Why callers must wait this out before playing a recorded move: the daemon's
 * move guard (`_try_start_move`) is a reentrant `threading.RLock` and every
 * command runs as an asyncio task on the SAME event-loop thread - so a
 * `goto_target` (itself a `GotoMove` through `play_move`) does NOT block a
 * concurrent `play_recorded_move`. Both playback loops then interleave
 * `set_target_*` at ~100 Hz and the robot trembles as the two trajectories
 * fight. Sequencing on the app side is the only reliable guard.
 */
export const RESET_HOLD_MS =
  RESET_GOTO_DURATION_S * 1000 + RESET_DISPATCH_JITTER_MS;

/**
 * Neutral "end of wake-up" pose, in the daemon's wire format:
 *  - head: identity 4x4 (flat, row-major) = level head (roll/pitch/yaw 0),
 *    matching `rpyToMatrix(0, 0, 0)`.
 *  - antennas: [-10 deg, +10 deg] in radians, matching `INIT_POSE`.
 *  - body_yaw: 0 (facing forward).
 */
const NEUTRAL_HEAD = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const NEUTRAL_ANTENNAS = [-0.17453292519943295, 0.17453292519943295];

/**
 * Send the robot to its neutral "end of wake-up" pose: head level, body facing
 * forward, antennas at their init angle - via a single daemon-side `goto_target`
 * (interpolated on the robot), NOT a streamed pose salvo. The robot is already
 * awake here, so a plain goto (rather than a replayed trajectory) is enough.
 *
 * Fires immediately. Pass `retries: 0` when the caller already knows the move
 * has ended (the event-driven path fires on the `is_move_running` falling edge),
 * so one goto is enough. Otherwise it re-fires on a short interval (see the retry
 * constants above) to survive being dropped while the preceding move is still
 * running (the blind, timer-based closing sequence). Returns a `cancel()` that
 * clears the pending retries - call it on unmount / handoff so no stray goto
 * bleeds into the next step or the conversation UI.
 */
export function resetToDefaultPose(
  session: RobotSessionHandle,
  opts: { retries?: number } = {},
): () => void {
  const retries = opts.retries ?? RESET_RETRY_COUNT;
  const apply = () => {
    const robot = session.getRobot();
    if (!robot) return;
    robot.gotoTarget({
      head: NEUTRAL_HEAD,
      antennas: NEUTRAL_ANTENNAS,
      body_yaw: 0,
      duration: RESET_GOTO_DURATION_S,
    });
  };
  apply();
  const timers: number[] = [];
  for (let i = 1; i <= retries; i++) {
    timers.push(window.setTimeout(apply, i * RESET_RETRY_INTERVAL_MS));
  }
  return () => {
    for (const t of timers) window.clearTimeout(t);
  };
}
