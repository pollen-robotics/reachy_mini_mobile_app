/**
 * Reactive view of "what robots does Hugging Face central know about
 * for this user, right now?".
 *
 * Backwards-compat wrapper around `useCentralSource` (PR-C). The
 * shape this hook returns is unchanged from PR-D so existing call
 * sites (notably the older `RemoteScreen.tsx`) keep working without
 * needing to know about the typed `ConnectionDiagnostic`. New
 * screens should depend on `useCentralSource` directly to access
 * structured diagnostics and adaptive polling controls.
 */
import { useMemo } from 'react';

import {
  useCentralSource,
  type CentralSourceState,
} from '../presence/centralSource';
import type { CentralRobotEntry } from './fetchRobotsFromCentral';

export type RemoteRobotsState =
  | { kind: 'no-token' }
  | { kind: 'loading'; robots: CentralRobotEntry[] }
  | { kind: 'ready'; robots: CentralRobotEntry[] }
  | { kind: 'error'; robots: CentralRobotEntry[]; reason: string };

export interface UseRemoteRobotsResult {
  state: RemoteRobotsState;
  refresh: () => Promise<void>;
}

/**
 * Map the richer central state to the legacy shape. `pollMs` is
 * accepted for API parity but the new source ignores it: it picks
 * its own adaptive cadence (fast while empty/erroring/visible, slow
 * once stable or hidden). Tests that need a custom cadence should
 * call `useCentralSource` directly.
 */
export function useRemoteRobots(
  token: string | null,
  _opts: { pollMs?: number } = {},
): UseRemoteRobotsResult {
  const { state, refresh } = useCentralSource(token);
  const adapted = useMemo(() => adapt(state), [state]);
  return { state: adapted, refresh };
}

function adapt(state: CentralSourceState): RemoteRobotsState {
  switch (state.kind) {
    case 'no-token':
      return state;
    case 'loading':
      return state;
    case 'ready':
      return { kind: 'ready', robots: state.robots };
    case 'error':
      return {
        kind: 'error',
        robots: state.robots,
        reason: state.diagnostic.message,
      };
  }
}
