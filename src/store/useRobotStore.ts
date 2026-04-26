import { create } from 'zustand';

import type { ConnectionState, DiscoveredRobot } from '../types/robot';

/**
 * Global store for the robot connection lifecycle.
 *
 * Single source of truth for every screen. Discovery is push-based: the
 * Rust side emits `robot:discovered` / `robot:lost` events, the
 * `useDiscovery` hook calls `upsertDiscovered` / `removeDiscovered` and
 * the ScanScreen simply renders `Object.values(discovered)`.
 */
interface RobotStore {
  connectionState: ConnectionState;
  /** Last human-readable error, cleared when a new action starts. */
  errorMessage: string | null;

  /**
   * Cache of discovered robots keyed by a stable identifier.
   *
   *   * For BLE entries the key is the peripheral address (macOS UUID,
   *     Linux MAC, etc.) so it remains stable across rescans.
   *   * For manual entries the key is `manual:${host}` so they never
   *     collide with the BLE set.
   */
  discovered: Record<string, DiscoveredRobot>;
  selectedRobot: DiscoveredRobot | null;

  /** IPv4 addresses of the phone, used for subnet comparison. */
  localIps: string[];

  setConnectionState: (state: ConnectionState) => void;
  setError: (message: string | null) => void;
  upsertDiscovered: (robot: DiscoveredRobot) => void;
  removeDiscovered: (key: string) => void;
  selectRobot: (robot: DiscoveredRobot | null) => void;
  setLocalIps: (ips: string[]) => void;
  /** Full reset, used on disconnect. Does not flush the discovery cache. */
  resetConnection: () => void;
}

export function discoveryKey(robot: DiscoveredRobot): string {
  return robot.address;
}

export const useRobotStore = create<RobotStore>(set => ({
  connectionState: 'idle',
  errorMessage: null,
  discovered: {},
  selectedRobot: null,
  localIps: [],

  setConnectionState: state => set({ connectionState: state }),
  setError: message => set({ errorMessage: message }),

  upsertDiscovered: robot =>
    set(prev => ({
      discovered: { ...prev.discovered, [discoveryKey(robot)]: robot },
    })),

  removeDiscovered: key =>
    set(prev => {
      if (!(key in prev.discovered)) return prev;
      const next = { ...prev.discovered };
      delete next[key];
      return { discovered: next };
    }),

  selectRobot: robot => set({ selectedRobot: robot }),
  setLocalIps: ips => set({ localIps: ips }),

  resetConnection: () =>
    set({ connectionState: 'idle', errorMessage: null, selectedRobot: null }),
}));
