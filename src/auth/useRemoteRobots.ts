/**
 * Reactive view of "what robots does Hugging Face central know about
 * for this user, right now?" - via TanStack Query.
 *
 * Wraps `fetchRobotsFromCentral` with token-aware lifecycle:
 *
 *   - `token === null`        → state: 'no-token' (UI shows sign-in CTA).
 *   - `token` set, first load → state: 'loading'.
 *   - Fetch ok                → state: 'ready' with `robots[]`.
 *   - Fetch failed            → state: 'error' with `reason`.
 *
 * The query refetches automatically when:
 *   - the token changes (it's part of the cache key, so a switch
 *     creates a new entry instead of leaking the old one),
 *   - `pollMs` elapses (default: 30 s, off when `pollMs <= 0`),
 *   - the consumer calls `refresh()`.
 *
 * Keeping the previous list visible across polls / refreshes is
 * given to us by TanStack Query's `data` cache: `refresh()` /
 * polling produce `isFetching === true` while `data` still holds
 * the last good value, so the UI doesn't blank between rounds.
 */
import { useQuery } from '@tanstack/react-query';

import {
  fetchRobotsFromCentral,
  type CentralRobotEntry,
} from './fetchRobotsFromCentral';

export type RemoteRobotsState =
  | { kind: 'no-token' }
  | { kind: 'loading'; robots: CentralRobotEntry[] }
  | { kind: 'ready'; robots: CentralRobotEntry[] }
  | { kind: 'error'; robots: CentralRobotEntry[]; reason: string };

export interface UseRemoteRobotsResult {
  state: RemoteRobotsState;
  /** Trigger an immediate refresh. No-op when there is no token. */
  refresh: () => Promise<void>;
}

const DEFAULT_POLL_MS = 30_000;

/**
 * Cache key shape: `['remote-robots', token]`.
 *
 * Including the token makes a sign-out / sign-in cycle replace the
 * cache slot rather than reuse it - we never want robot data
 * stamped against another user's session to flash in the UI.
 */
function remoteRobotsKey(token: string): readonly unknown[] {
  return ['remote-robots', token] as const;
}

export function useRemoteRobots(
  token: string | null,
  opts: { pollMs?: number } = {},
): UseRemoteRobotsResult {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  const query = useQuery({
    // The cache slot is keyed on the token; with `enabled: false`
    // for null tokens, no query is registered until sign-in.
    queryKey: token ? remoteRobotsKey(token) : ['remote-robots', null],
    queryFn: async () => {
      if (!token) {
        // Defensive - `enabled: false` should keep this from
        // firing, but TanStack Query's queryFn must always exist.
        throw new Error('No HF token');
      }
      const result = await fetchRobotsFromCentral(token);
      if (!result.ok) {
        throw new Error(result.reason ?? 'Unknown error');
      }
      return result.robots;
    },
    enabled: !!token,
    refetchInterval: pollMs > 0 ? pollMs : false,
    // Keep the polling running even when the WebView is in the
    // background so the user finds an up-to-date list when they
    // re-foreground the app.
    refetchIntervalInBackground: true,
    staleTime: pollMs > 0 ? pollMs : Infinity,
  });

  const robots = query.data ?? [];

  let state: RemoteRobotsState;
  if (!token) {
    state = { kind: 'no-token' };
  } else if (query.isFetching && robots.length === 0 && !query.isError) {
    state = { kind: 'loading', robots: [] };
  } else if (query.isError) {
    state = {
      kind: 'error',
      robots,
      reason:
        query.error instanceof Error
          ? query.error.message
          : String(query.error),
    };
  } else if (query.isFetching) {
    // Refresh / poll in-flight with a previous list still
    // available. Surface as `loading` (with the cached list) so
    // the UI can decorate the existing rows with a spinner if it
    // wants to, without blanking.
    state = { kind: 'loading', robots };
  } else {
    state = { kind: 'ready', robots };
  }

  const refresh = async (): Promise<void> => {
    if (!token) return;
    await query.refetch();
  };

  return { state, refresh };
}
