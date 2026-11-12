/**
 * React binding for the antenna start (`./startup-app`): reads the setting
 * each time the link to the robot comes up, and hides it while the link is
 * down so the switch never shows a value it cannot change.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import {
  createStartupAppController,
  INITIAL_STARTUP_APP_STATE,
  type StartupAppController,
} from './startup-app';

export function useStartupApp(getRobot: () => ReachyMiniInstance | null, live: boolean) {
  const [state, setState] = useState(INITIAL_STARTUP_APP_STATE);
  const controllerRef = useRef<StartupAppController | null>(null);

  useEffect(() => {
    if (!live) return;
    const controller = createStartupAppController(getRobot, setState);
    controllerRef.current = controller;
    void controller.refresh();
    return () => {
      controller.dispose();
      controllerRef.current = null;
      setState(INITIAL_STARTUP_APP_STATE);
    };
  }, [getRobot, live]);

  const setStartup = useCallback((next: boolean) => {
    void controllerRef.current?.toggle(next);
  }, []);

  return { ...state, setStartup };
}
