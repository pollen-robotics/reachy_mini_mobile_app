import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { useRobotStore } from '../store/useRobotStore';

interface LocalInterface {
  name: string;
  ip: string;
}

/**
 * Populate `localIps` in the store from the Rust `local_ips` command.
 *
 * Called once from the root `App` component - the list rarely changes
 * during a session (airplane mode toggles being the main edge case, and we
 * accept the one-shot staleness for v0). If we ever need live updates we
 * can poll every ~30 s here.
 */
export function useLocalIps(): void {
  const setLocalIps = useRobotStore(s => s.setLocalIps);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const interfaces = await invoke<LocalInterface[]>('local_ips');
        if (!cancelled) {
          setLocalIps(interfaces.map(i => i.ip));
        }
      } catch (e) {
        console.warn('[network] local_ips failed', e);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [setLocalIps]);
}
