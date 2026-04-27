/**
 * React binding for the `robotMotion` observable store.
 *
 * Wraps `subscribeMotion` / `getMotionState` in `useSyncExternalStore`
 * so React 18's concurrent rendering doesn't tear when a transition
 * lands during a render. The store itself lives in module scope
 * (singleton across the whole app) so this hook is just a window
 * onto it.
 *
 * Usage:
 *
 *     const motion = useMotionState();
 *     if (motion.lastOutcome === 'bus_stuck') ...
 *     if (!motion.safeToShutdown) ...   // gate the leaving phase
 */
import { useSyncExternalStore } from 'react';

import {
  getMotionState,
  subscribeMotion,
  type MotionState,
} from './robotMotion';

export function useMotionState(): MotionState {
  return useSyncExternalStore(subscribeMotion, getMotionState, getMotionState);
}
