/**
 * Who is driving the robot right now.
 *
 * The phone wakes the robot at bring-up and plays a goto-sleep on the way out.
 * Both command the motor bus, so both have to stand down when a Hub app is
 * driving: the app and the phone would otherwise fight over the same joints.
 *
 * The answer is advisory, so every failure reads as "nobody else": a daemon
 * that cannot say is not a reason to leave the robot awake and unposed.
 */
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { CONV_APP_NAME, createConvAppClient, type CurrentAppStatus } from './client';

const STATUS_TIMEOUT_MS = 2_000;

/** The app the robot runs or is starting, or `null` (idle, timeout, error). */
async function readActiveApp(robot: ReachyMiniInstance): Promise<CurrentAppStatus | null> {
  try {
    const app = await Promise.race([
      createConvAppClient(robot).getCurrentAppStatus(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), STATUS_TIMEOUT_MS)),
    ]);
    if (!app) return null;
    return app.state === 'running' || app.state === 'starting' ? app : null;
  } catch (err) {
    console.warn('[conv-app] could not read who holds the robot:', err);
    return null;
  }
}

export async function isAnotherAppDrivingRobot(robot: ReachyMiniInstance): Promise<boolean> {
  const app = await readActiveApp(robot);
  // Our own conversation app is stopped by the teardown that precedes both
  // guards, and it does not hold the motors the way a Hub app does.
  return app !== null && app.info?.name !== CONV_APP_NAME;
}

/**
 * Name of the app other than the conversation that runs on the robot, or
 * `null`. For callers that have to name it to the user before taking the
 * motors from it.
 */
export async function getOtherRunningAppName(robot: ReachyMiniInstance): Promise<string | null> {
  const app = await readActiveApp(robot);
  if (app === null) return null;
  const name = app.info?.name ?? null;
  return name === CONV_APP_NAME ? null : (name ?? 'another app');
}

/**
 * True when any app, the conversation app included, runs on the robot. The
 * bring-up wake asks this rather than `isAnotherAppDrivingRobot`: at connect
 * nothing has been torn down yet, and the conversation app may be running
 * because the robot started it by itself (antenna touch, see `startup-app.ts`).
 */
export async function isAnyAppDrivingRobot(robot: ReachyMiniInstance): Promise<boolean> {
  return (await readActiveApp(robot)) !== null;
}

/**
 * Resolve once the conversation app no longer holds the robot (not running,
 * starting or stopping), or after `timeoutMs`. An unreadable status counts
 * as gone: this only orders the caller after the app's exit, it must not
 * hold a teardown on a robot that stopped answering.
 */
export async function waitForConvAppExit(
  robot: ReachyMiniInstance,
  timeoutMs: number,
  pollMs = 500
): Promise<void> {
  const client = createConvAppClient(robot);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let app: CurrentAppStatus | null;
    try {
      app = await Promise.race([
        client.getCurrentAppStatus(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), STATUS_TIMEOUT_MS)),
      ]);
    } catch {
      return;
    }
    if (!app || app.info?.name !== CONV_APP_NAME) return;
    if (app.state !== 'running' && app.state !== 'starting' && app.state !== 'stopping') return;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

/** True when the robot is running (or starting) the conversation app. */
export async function isConvAppRunning(robot: ReachyMiniInstance): Promise<boolean> {
  const app = await readActiveApp(robot);
  return app?.info?.name === CONV_APP_NAME;
}
