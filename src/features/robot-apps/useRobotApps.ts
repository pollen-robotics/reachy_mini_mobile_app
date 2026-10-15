/**
 * React binding of the robot's Python apps.
 *
 * Controllers are kept per robot for the whole app lifetime (see
 * `controller.ts`): an install started before a tab switch or a reconnect is
 * still the one on screen afterwards.
 */
import { useEffect, useSyncExternalStore } from 'react';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { RobotAppsController } from './controller';
import type { RobotAppsSnapshot } from './types';

const controllers = new Map<string, RobotAppsController>();
/** Latest `getRobot` per robot: the session hook may hand a new one per render. */
const robotGetters = new Map<string, () => ReachyMiniInstance | null>();

function controllerFor(robotId: string): RobotAppsController {
  let controller = controllers.get(robotId);
  if (!controller) {
    controller = new RobotAppsController({
      getRobot: () => robotGetters.get(robotId)?.() ?? null,
    });
    controllers.set(robotId, controller);
  }
  return controller;
}

export interface UseRobotAppsOptions {
  robotId: string;
  getRobot: () => ReachyMiniInstance | null;
  /** Poll the robot: Apps tab on screen, session live, no iframe holding it. */
  active: boolean;
  /** The session is up (phase `live`); actions are refused otherwise. */
  online: boolean;
}

export interface RobotAppsHandle {
  snapshot: RobotAppsSnapshot;
  controller: RobotAppsController;
}

export function useRobotApps({
  robotId,
  getRobot,
  active,
  online,
}: UseRobotAppsOptions): RobotAppsHandle {
  robotGetters.set(robotId, getRobot);
  const controller = controllerFor(robotId);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => controller.setOnline(online), [controller, online]);

  useEffect(() => {
    // Pause while the phone is backgrounded: the poll would only queue
    // calls on a data channel the OS may be throttling.
    const sync = () => controller.setActive(active && document.visibilityState === 'visible');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      controller.setActive(false);
    };
  }, [controller, active]);

  return { snapshot, controller };
}
