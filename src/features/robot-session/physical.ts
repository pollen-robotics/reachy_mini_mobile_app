/**
 * Physical robot operations: wake-up, sleep, motor mode.
 *
 * Wraps the SDK's lower-level methods with our hard-timeout
 * defenses. The SDK bounds `ensureAwake()` / `gotoSleep()`
 * internally, but a wedged daemon (libnice crash mid-trajectory,
 * lost data channel, …) combined with an older SDK build won't
 * reject - it'll just sit there. The outer `Promise.race` with a
 * slightly longer JS timeout is the belt to the SDK's braces:
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
 * JS-side hard cap on `ensureAwake()`. The SDK bounds itself
 * internally (<= 1 s state snapshot + 5 s trajectory budget), so
 * this only fires against an SDK/daemon combination that misbehaves;
 * 7 s leaves the internal budgets room to resolve first.
 */
const DEFAULT_WAKE_HARD_TIMEOUT_MS = 7_000;

/** Sleep trajectory budgets: SDK-level timeout + JS hard cap. */
const DEFAULT_SLEEP_TIMEOUT_MS = 6_000;
const DEFAULT_SLEEP_HARD_TIMEOUT_MS = 6_500;

/**
 * Make sure the robot is awake, via the SDK's idempotent
 * `ensureAwake()`: instant no-op when the robot is already under
 * position control, silent mode flip when it inherited
 * `gravity_compensation`, full wake trajectory AWAITED otherwise.
 * Never throws; a slow / failed wake is logged and swallowed because
 * the engine needs to proceed to `ready` either way (the user can't
 * do anything useful while we'd block them on a stuck wake).
 */
export async function wakeRobot(robot: ReachyMiniInstance): Promise<void> {
  const t0 = performance.now();
  try {
    await Promise.race([
      robot.ensureAwake(),
      new Promise<void>((resolve) =>
        setTimeout(resolve, DEFAULT_WAKE_HARD_TIMEOUT_MS),
      ),
    ]);
    console.log(
      `[physical] wakeRobot: done in ${Math.round(performance.now() - t0)}ms`,
    );
  } catch (err) {
    console.warn(
      `[physical] wakeRobot: failed after ${Math.round(performance.now() - t0)}ms (ignored):`,
      err,
    );
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
  const t0 = performance.now();

  try {
    await Promise.race([
      robot.gotoSleep({ timeoutMs }),
      new Promise<void>((resolve) => setTimeout(resolve, hardTimeoutMs)),
    ]);
  } catch (err) {
    console.warn(
      `[physical] gotoSleep failed after ${Math.round(performance.now() - t0)}ms (ignored):`,
      err,
    );
  }

  try {
    robot.setMotorMode('disabled');
    console.log(
      `[physical] sleepAndDisable: done in ${Math.round(performance.now() - t0)}ms`,
    );
    return { motorMode: 'disabled' };
  } catch (err) {
    console.warn(
      `[physical] setMotorMode("disabled") failed after ${Math.round(
        performance.now() - t0,
      )}ms (ignored):`,
      err,
    );
    return { motorMode: null };
  }
}
