/**
 * Like / unlike a Space from inside the mobile app.
 *
 * Two cooperating hooks:
 *
 *   - `useSpaceLikes()` - app-wide state. Hydrates the set of Spaces
 *     the current user has liked (`GET /api/users/{username}/likes`)
 *     and exposes a `toggle(appId)` action that does the optimistic
 *     dance + REST call.
 *
 *   - `useSpaceLike(app)` - per-tile view-model. Returns the
 *     `isLiked` boolean, a `displayedCount` (catalog count + a local
 *     +1/-1/0 delta reflecting the user's optimistic action) and a
 *     `toggle()` shortcut bound to that app.
 *
 * State model
 * ───────────
 * We hold two sets in the TanStack Query cache:
 *
 *   - `server`     - the user's liked set as it was at hydration
 *                    time (i.e. when `GET /api/users/{username}/likes`
 *                    returned). Treated as **immutable** for the rest
 *                    of the session: it is the baseline against which
 *                    the catalog's `app.likes` count was minted, and
 *                    therefore the reference point we diff against to
 *                    compute the local +1 / -1 delta.
 *   - `optimistic` - the current UI state. Toggled instantly on
 *                    user tap; reverted to `server` on REST failure.
 *
 * The `displayedCount` delta is simply
 * `(optimistic.has - server.has)` applied to the catalog's
 * `app.likes` count.
 *
 * Why we never update `server` after a mutation
 * ─────────────────────────────────────────────
 * Earlier revisions of this hook promoted the optimistic value into
 * `server` on `onSuccess`, with the intent of "the server now agrees
 * with us". That broke the count: `app.likes` is a static snapshot
 * coming from the catalog and is *not* refreshed mid-session, so
 * collapsing the delta to 0 after a successful POST made the counter
 * drop back to the catalog value (e.g. 5 → 6 on tap → 5 right after
 * the 200), giving the impression that the like had failed. Keeping
 * `server` frozen at the hydration snapshot makes the +1 stick after
 * confirmation, which is what the user expects.
 *
 * Auth & graceful degradation
 * ──────────────────────────
 * - No token / no username → `isLiked === false` everywhere and
 *   `toggle()` becomes a no-op (`canToggle === false`). The UI is
 *   expected to surface "Sign in to like" instead of attempting the
 *   call.
 * - The HF backend currently rejects `POST /like` for personal
 *   access tokens; the token issued by our PKCE flow is an OAuth
 *   token, so this path is allowed. A 403 still bubbles up via
 *   `lastError` so the UI can suggest re-signing-in (typical dev
 *   case: someone pasted a PAT into localStorage).
 */
import { useCallback, useEffect, useMemo } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { queryClient } from '@/queryClient';
import { useRemoteHfToken } from '@/features/auth/useRemoteHfToken';

import {
  LikeForbiddenError,
  LikeUnauthorizedError,
  fetchUserLikedSpaces,
  likeSpace,
  unlikeSpace,
} from './likesApi';

/**
 * Shape stored in the TanStack Query cache. Carries the
 * server-confirmed snapshot and the optimistic projection in a
 * single record so the mutation handlers can read/write both
 * atomically (no risk of the two diverging across renders).
 */
interface LikedSpacesCache {
  server: Set<string>;
  optimistic: Set<string>;
}

const EMPTY_CACHE: LikedSpacesCache = Object.freeze({
  server: new Set<string>(),
  optimistic: new Set<string>(),
}) as LikedSpacesCache;

/**
 * Freshness window for the liked-set query. The user's likes change
 * rarely within a session and we update the cache locally on every
 * mutation, so we don't need to refetch on every focus / mount.
 *
 * Shared between `useSpaceLikes()` and `prefetchSpaceLikes()`: the
 * prefetch MUST agree with the live query, otherwise warming the
 * cache at app boot would mark the entry fresh on a different window
 * and suppress the hook's own revalidations.
 */
const LIKES_STALE_TIME_MS = 10 * 60 * 1000;

function likesQueryKey(username: string | null): readonly unknown[] {
  return ['hf-liked-spaces', username] as const;
}

/**
 * Fetch the user's liked set and seed the optimistic view with the
 * server snapshot so the first paint has the right hearts filled.
 * Shared by the live query and the boot-time prefetch.
 */
async function loadLikedSpacesCache(
  token: string,
  username: string,
): Promise<LikedSpacesCache> {
  const liked = await fetchUserLikedSpaces(token, username);
  return {
    server: liked,
    optimistic: new Set(liked),
  };
}

/**
 * Warm the liked-Spaces cache. Idempotent (TanStack dedupes against
 * the same key), so calling it at app boot AND mounting
 * `useSpaceLikes()` later shares a single network call. Mirrors
 * `prefetchMyApps()` / `prefetchApps()` so every per-user list is
 * warm by the time the Apps tab opens.
 */
export function prefetchSpaceLikes(
  token: string,
  username: string,
): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: likesQueryKey(username),
    queryFn: () => loadLikedSpacesCache(token, username),
    staleTime: LIKES_STALE_TIME_MS,
  });
}

/**
 * Hook variant of `prefetchSpaceLikes()` for the App root. No-ops
 * while signed out (no token / username); re-fires when the username
 * changes (account switch) so the cache slot for the new user warms
 * up immediately.
 */
export function usePrefetchSpaceLikes(): void {
  const { token, username } = useRemoteHfToken();
  useEffect(() => {
    if (!token || !username) return;
    void prefetchSpaceLikes(token, username);
  }, [token, username]);
}

/**
 * App-wide hook. Mount it once near the top of the apps panel and
 * the returned object can be consumed by every tile (no extra
 * network: TanStack Query dedupes against the same key).
 */
export function useSpaceLikes() {
  const { token, username } = useRemoteHfToken();
  const queryClient = useQueryClient();

  const queryKey = useMemo(() => likesQueryKey(username), [username]);
  const enabled = !!token && !!username;

  const query = useQuery<LikedSpacesCache>({
    queryKey,
    // `enabled: false` paths still get the query function typed,
    // but TanStack guarantees it won't run unless we have both a
    // token AND a username, so we can assert non-null here.
    queryFn: () => loadLikedSpacesCache(token as string, username as string),
    enabled,
    staleTime: LIKES_STALE_TIME_MS,
  });

  // When the query isn't enabled (signed-out) we still want a stable
  // empty cache so consumers can `cache.optimistic.has(...)` without
  // null checks.
  const cache: LikedSpacesCache = query.data ?? EMPTY_CACHE;

  const mutation = useMutation<
    void,
    Error,
    { appId: string; nextState: 'liked' | 'unliked' },
    { previous: LikedSpacesCache | undefined }
  >({
    mutationFn: async ({ appId, nextState }) => {
      if (!token) throw new Error('Sign in required to like Spaces');
      if (nextState === 'liked') {
        await likeSpace(token, appId);
      } else {
        await unlikeSpace(token, appId);
      }
    },
    onMutate: async ({ appId, nextState }) => {
      // Cancel any in-flight fetches that could overwrite our
      // optimistic update mid-air, then snapshot the previous cache
      // for the rollback path.
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<LikedSpacesCache>(queryKey);
      const baseline = previous ?? EMPTY_CACHE;
      const nextOptimistic = new Set(baseline.optimistic);
      if (nextState === 'liked') nextOptimistic.add(appId);
      else nextOptimistic.delete(appId);
      queryClient.setQueryData<LikedSpacesCache>(queryKey, {
        server: baseline.server,
        optimistic: nextOptimistic,
      });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      } else {
        queryClient.setQueryData<LikedSpacesCache>(queryKey, EMPTY_CACHE);
      }
    },
    // No `onSuccess` cache write: `server` is the hydration snapshot
    // and stays frozen for the session, so the `(optimistic - server)`
    // delta keeps reflecting the user's local +1/-1 even after the
    // REST call confirms. The `onMutate` write is already the final
    // state for a successful mutation.
  });

  const isLiked = useCallback(
    (appId: string): boolean => cache.optimistic.has(appId),
    [cache],
  );

  /**
   * Compute the local `+1 / 0 / -1` delta the UI should apply to the
   * catalog's like count for this app. Computed as
   * `optimistic.has - server.has`, where `server` is the hydration
   * snapshot (frozen for the session). So a freshly liked app keeps
   * showing `+1` until the next hydration, which is when the catalog
   * count itself gets re-fetched too.
   */
  const countDelta = useCallback(
    (appId: string): number => {
      const optimistic = cache.optimistic.has(appId) ? 1 : 0;
      const server = cache.server.has(appId) ? 1 : 0;
      return optimistic - server;
    },
    [cache],
  );

  const toggle = useCallback(
    (appId: string): void => {
      if (!enabled) return;
      const nextState: 'liked' | 'unliked' = cache.optimistic.has(appId)
        ? 'unliked'
        : 'liked';
      mutation.mutate({ appId, nextState });
    },
    [cache, enabled, mutation],
  );

  const lastError = mutation.error
    ? mutation.error instanceof LikeUnauthorizedError
      ? ('unauthorized' as const)
      : mutation.error instanceof LikeForbiddenError
        ? ('forbidden' as const)
        : ('error' as const)
    : null;

  return {
    /** True iff the user is signed in (and therefore `toggle()` will act). */
    canToggle: enabled,
    /** Initial hydration in flight. */
    isHydrating: query.isLoading,
    isLiked,
    countDelta,
    toggle,
    /**
     * Last mutation outcome, surfaced for UIs that want to react to
     * a 403 (e.g. "this token isn't an OAuth token, please sign in
     * again"). `null` between attempts.
     */
    lastError,
  };
}

/**
 * Per-app convenience hook. Wraps `useSpaceLikes` and applies the
 * delta to the catalog's `app.likes` count so the tile gets a single
 * `displayedCount` it can render unconditionally.
 */
export function useSpaceLike(app: { id: string; likes?: number }) {
  const likes = useSpaceLikes();
  const baseCount = app.likes ?? 0;
  const liked = likes.isLiked(app.id);
  const delta = likes.countDelta(app.id);
  const displayedCount = Math.max(0, baseCount + delta);
  return {
    canToggle: likes.canToggle,
    isLiked: liked,
    displayedCount,
    toggle: () => likes.toggle(app.id),
    lastError: likes.lastError,
  };
}
