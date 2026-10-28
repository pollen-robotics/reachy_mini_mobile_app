/**
 * Whether touching Reachy's antennas while it sleeps starts the conversation
 * app, with no phone involved. The daemon owns the setting (its "startup
 * app", `apps.get_startup` / `apps.set_startup`); the phone only flips it.
 */
import { useCallback, useEffect, useState } from 'react';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { createConvAppClient } from './client';

/** `enabled` is `null` until read, and stays so on a daemon without the verbs. */
export function useStartupApp(getRobot: () => ReachyMiniInstance | null, live: boolean) {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    const robot = getRobot();
    if (!live || !robot) return;
    let cancelled = false;
    createConvAppClient(robot)
      .isStartupApp()
      .then(
        value => !cancelled && setEnabled(value),
        (err: unknown) => console.debug('[startup-app] apps.get_startup:', err)
      );
    return () => {
      cancelled = true;
    };
  }, [getRobot, live]);

  const setStartup = useCallback(
    async (next: boolean) => {
      const robot = getRobot();
      if (!robot) return;
      setEnabled(next);
      try {
        await createConvAppClient(robot).setStartupApp(next);
      } catch (err) {
        console.warn('[startup-app] apps.set_startup failed:', err);
        setEnabled(!next);
      }
    },
    [getRobot]
  );

  return { enabled, setStartup };
}
