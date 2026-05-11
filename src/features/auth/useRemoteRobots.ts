/**
 * Reactive view of "what robots does Hugging Face central know about
 * for this user, right now?" - via TanStack Query, with a real-time
 * SSE listener layered on top.
 *
 * Two data planes
 * ───────────────
 *
 * 1. `fetchRobotsFromCentral` REST call (`/api/robot-status`):
 *    - First load (cold start), refresh button, periodic safety-net
 *      poll. Authoritative for the initial render and any transient
 *      missed-event scenario.
 *
 * 2. `openCentralListener` SSE stream (`/events`):
 *    - Realtime push of busy/free transitions and online/offline
 *      changes from central. We patch the TanStack Query cache as
 *      events arrive so the UI flips within ~50 ms instead of
 *      waiting on the next poll. On a stream drop, the next
 *      `onConnect` (after backoff reconnect) triggers a REST
 *      refetch so we recover any state changes we missed during
 *      the gap.
 *
 * Token-aware lifecycle
 * ─────────────────────
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
 *   - the consumer calls `refresh()`,
 *   - the SSE listener reconnects after a drop.
 *
 * Keeping the previous list visible across polls / refreshes is
 * given to us by TanStack Query's `data` cache: `refresh()` /
 * polling produce `isFetching === true` while `data` still holds
 * the last good value, so the UI doesn't blank between rounds.
 */
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  fetchRobotsFromCentral,
  type CentralRobotEntry,
} from './fetchRobotsFromCentral';
import {
  openCentralListener,
  type CentralListenerHandle,
  type CentralPeerStatusChangedEvent,
  type CentralSessionStateChangedEvent,
} from './centralListenerStream';
import { dropProducer, patchBusyState } from './remoteRobotsReducers';

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

/**
 * REST poll cadence. Raised from 30 s → 60 s once the SSE listener
 * became the primary source of truth for busy/free transitions:
 * the poll's job is no longer "stay fresh" but "recover from a
 * missed push" (transient SSE drop, central restart between two
 * events, future fields we don't yet patch in the reducer). 60 s
 * matches the lease window's halving baseline and roughly halves
 * the request rate against the HF Space.
 */
const DEFAULT_POLL_MS = 60_000;

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
  const queryClient = useQueryClient();

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

  // Mount the SSE listener for the lifetime of the hook (= as long
  // as the screen using it stays mounted, typically `ScanScreen`).
  // On a robot-tap the screen unmounts, this cleanup runs, and the
  // SSE channel closes BEFORE the SDK opens its own SSE on the
  // same token (which would otherwise tear ours down server-side
  // via the `token_to_peer` 1:1 mapping). Plain useEffect deps on
  // `[token, queryClient]` so a sign-out / sign-in cycle reopens
  // the stream.
  //
  // We deliberately keep the REST poll running in parallel rather
  // than disabling it once the SSE is connected: the poll is the
  // safety net for any push event we miss (transient SSE drop, a
  // central restart between two events, a future schema bump that
  // adds a field we don't yet apply). Cost: ~1 KB / 30 s, totally
  // negligible.
  const droppedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!token) return;
    const cacheKey = remoteRobotsKey(token);

    const handle: CentralListenerHandle = openCentralListener({
      token,
      onConnect: () => {
        // Reconnect after a drop: the cache may have missed
        // events while the stream was down. Trigger a REST
        // refetch to converge. Skipped on the very first connect
        // because the initial REST `queryFn` is already in flight
        // (or just returned).
        if (droppedAtRef.current !== null) {
          droppedAtRef.current = null;
          void queryClient.invalidateQueries({ queryKey: cacheKey });
        }
      },
      onDisconnect: () => {
        droppedAtRef.current = Date.now();
      },
      onPeerStatusChanged: (event: CentralPeerStatusChangedEvent) => {
        // `roles: []` means the producer withdrew or disconnected.
        // `roles: ["producer"]` means it (re)appeared. For the
        // appearance case we don't have full meta in the event
        // (central forwards just the registration), so the
        // simplest correct behaviour is to invalidate the query
        // and let the REST refetch hydrate the new row. Cheaper
        // than maintaining a parallel reducer that has to know
        // every field central forwards.
        if (event.roles.length === 0) {
          queryClient.setQueryData<CentralRobotEntry[]>(cacheKey, prev =>
            dropProducer(prev, event.peerId),
          );
        } else {
          void queryClient.invalidateQueries({ queryKey: cacheKey });
        }
      },
      onSessionStateChanged: (event: CentralSessionStateChangedEvent) => {
        // Cheap reducer: just patch busy / activeApp on the
        // matching row. The whole point of Palier 2 is to avoid
        // a full REST refetch on every busy/free transition.
        queryClient.setQueryData<CentralRobotEntry[]>(cacheKey, prev =>
          patchBusyState(prev, event.peerId, event.busy, event.activeApp),
        );
      },
      onError: err => {
        console.warn('[remote] central listener error:', err.message);
      },
    });

    return () => handle.close();
  }, [token, queryClient]);

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
