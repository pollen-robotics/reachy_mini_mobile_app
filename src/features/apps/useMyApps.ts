/**
 * "Your apps" hook — the Reachy JS apps owned by the signed-in user.
 *
 * Thin TanStack Query wrapper over `fetchMyReachyApps`, modelled on
 * `useSpaceLikes`:
 *   - keyed by the username so a sign-out / account switch swaps the
 *     cache slot cleanly,
 *   - `enabled` only when we have BOTH a token and a username,
 *   - 10-minute staleness (the user's Space list barely moves within
 *     a session, and the rail is a convenience shortcut, not the
 *     source of truth for launching).
 *
 * Degrades gracefully: signed-out or on error it just returns an
 * empty list, so the consumer can render nothing without null checks.
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import { queryClient } from '@/queryClient';
import { useRemoteHfToken } from '@/features/auth/useRemoteHfToken';

import type { AppEntry } from './types';
import { fetchMyReachyApps } from './myAppsApi';

const MY_APPS_STALE_TIME_MS = 10 * 60 * 1000;

function myAppsQueryKey(username: string | null): readonly unknown[] {
  return ['my-reachy-apps', username] as const;
}

/**
 * Warm the "Your apps" cache. Idempotent (TanStack dedupes against
 * the same key), so calling it at app boot AND mounting `useMyApps()`
 * later shares a single network call. Mirrors `prefetchApps()` for
 * the catalog so both lists are warm by the time the Apps tab opens.
 */
export function prefetchMyApps(token: string, username: string): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: myAppsQueryKey(username),
    queryFn: () => fetchMyReachyApps(token, username),
    // MUST match `useMyApps()` below, otherwise the prefetch would
    // mark the entry fresh on a different window and suppress the
    // hook's own revalidations.
    staleTime: MY_APPS_STALE_TIME_MS,
  });
}

/**
 * Hook variant of `prefetchMyApps()` for the App root. No-ops while
 * signed out (no token / username); re-fires when the username
 * changes (account switch) so the cache slot for the new user warms
 * up immediately.
 */
export function usePrefetchMyApps(): void {
  const { token, username } = useRemoteHfToken();
  useEffect(() => {
    if (!token || !username) return;
    void prefetchMyApps(token, username);
  }, [token, username]);
}

interface UseMyAppsReturn {
  apps: AppEntry[];
  isLoading: boolean;
}

export function useMyApps(): UseMyAppsReturn {
  const { token, username } = useRemoteHfToken();
  const enabled = !!token && !!username;

  const query = useQuery<AppEntry[]>({
    queryKey: myAppsQueryKey(username),
    queryFn: () => fetchMyReachyApps(token as string, username as string),
    enabled,
    staleTime: MY_APPS_STALE_TIME_MS,
  });

  return {
    apps: query.data ?? [],
    isLoading: enabled && query.isLoading,
  };
}
