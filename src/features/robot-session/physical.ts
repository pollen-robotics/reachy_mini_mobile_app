/**
 * Physical robot operations: wake-up, sleep, motor mode.
 *
 * Wraps the SDK's lower-level methods with our hard-timeout
 * defenses. The daemon SHOULD honour the `timeoutMs` parameter
 * on `wakeUp()` / `gotoSleep()`, but a wedged daemon (libnice
 * crash mid-trajectory, lost data channel, …) won't reject -
 * it'll just sit there. The outer `Promise.race` with a slightly
 * longer JS timeout is the belt to the daemon's braces:
 * guaranteed to resolve in bounded time so the engine never
 * stays parked in `starting` / `tearing-down` forever.
 *
 * No state ownership: these are pure operations parameterised by
 * the SDK robot ref. Eventually they'll become methods on a
 * RobotSession class; for now the engine calls them directly
 * (and `useRobotSession` already exposes a high-level `tearDown`
 * that funnels through the engine).
 */
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

/**
 * SDK-level wake timeout. The daemon stops the wake trajectory
 * and rejects after this if the motors / audio board take too
 * long to come up. 8 s is the canonical value used across the
 * desktop + mobile clients.
 */
const DEFAULT_WAKE_TIMEOUT_MS = 8_000;

/**
 * JS-side hard cap. Slightly larger than the SDK timeout so a
 * well-behaved daemon resolves first; a wedged one is unblocked
 * by us instead of stalling the FSM. 500 ms slack is enough for
 * the SDK's internal timer + DataChannel ack roundtrip.
 */
const DEFAULT_WAKE_HARD_TIMEOUT_MS = 8_500;

/** Same pair, applied to gotoSleep. */
const DEFAULT_SLEEP_TIMEOUT_MS = 6_000;
const DEFAULT_SLEEP_HARD_TIMEOUT_MS = 6_500;

export interface WakeRobotOptions {
  /** SDK-level timeout passed to `robot.wakeUp({ timeoutMs })`. */
  timeoutMs?: number;
  /** JS-side hard cap on the wake-up Promise (defends against a
   *  daemon that ignores its own timeout). Should be slightly
   *  larger than `timeoutMs`. */
  hardTimeoutMs?: number;
}

/**
 * Wake the robot and wait for the trajectory to complete (or for
 * our hard timeout to fire, whichever comes first). Never throws;
 * a slow / failed wake is logged and swallowed because the engine
 * needs to proceed to `ready` either way (the user can't do
 * anything useful while we'd block them on a stuck wake).
 */
export async function wakeRobot(
  robot: ReachyMiniInstance,
  opts: WakeRobotOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
  const hardTimeoutMs = opts.hardTimeoutMs ?? DEFAULT_WAKE_HARD_TIMEOUT_MS;
  try {
    await Promise.race([
      robot.wakeUp({ timeoutMs }),
      new Promise<void>((resolve) => setTimeout(resolve, hardTimeoutMs)),
    ]);
  } catch (err) {
    console.warn('[physical] wakeUp failed (ignored):', err);
  }
}

export interface SleepAndDisableOptions {
  /** SDK-level timeout passed to `robot.gotoSleep({ timeoutMs })`. */
  timeoutMs?: number;
  /** JS-side hard cap on the sleep trajectory. */
  hardTimeoutMs?: number;
}

/**
 * Play the goto-sleep trajectory and disable motors. Two-step:
 *
 *   1. `gotoSleep()` plays the head/antennas trajectory back to
 *      neutral. Bounded by the same outer-timeout pattern as
 *      `wakeRobot`.
 *   2. `setMotorMode('disabled')` is the belt-and-braces. Even
 *      if `gotoSleep()` returned `completed: true` the daemon's
 *      motor mode logic isn't guaranteed to disable torque after
 *      the trajectory (only the version controlled by THIS
 *      codebase does). Pushing the explicit disable makes the
 *      off-switch deterministic across daemon revisions.
 *
 * Synchronous on the DataChannel: must be called BEFORE
 * `stopSession()` so it lands while the WebRTC session is still
 * up. The engine's `teardown()` orders these correctly.
 *
 * Never throws; failures are logged and swallowed (a wedged
 * daemon should not block the engine's teardown indefinitely).
 *
 * Returns the motor mode actually applied (`'disabled'` on
 * success, `null` if the setMotorMode call threw). The engine
 * uses this to update its `lastSetMotorMode` cache.
 */
export async function sleepAndDisableRobot(
  robot: ReachyMiniInstance,
  opts: SleepAndDisableOptions = {},
): Promise<{ motorMode: 'disabled' | null }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SLEEP_TIMEOUT_MS;
  const hardTimeoutMs = opts.hardTimeoutMs ?? DEFAULT_SLEEP_HARD_TIMEOUT_MS;

  try {
    await Promise.race([
      robot.gotoSleep({ timeoutMs }),
      new Promise<void>((resolve) => setTimeout(resolve, hardTimeoutMs)),
    ]);
  } catch (err) {
    console.warn('[physical] gotoSleep failed (ignored):', err);
  }

  try {
    robot.setMotorMode('disabled');
    return { motorMode: 'disabled' };
  } catch (err) {
    console.warn('[physical] setMotorMode("disabled") failed (ignored):', err);
    return { motorMode: null };
  }
}
