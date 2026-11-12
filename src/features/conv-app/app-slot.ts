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

/** True when the robot is running (or starting) the conversation app. */
export async function isConvAppRunning(robot: ReachyMiniInstance): Promise<boolean> {
  const app = await readActiveApp(robot);
  return app?.info?.name === CONV_APP_NAME;
}
