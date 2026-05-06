/**
 * Single shared QueryClient for the mobile app.
 *
 * TanStack Query is the source of truth for two surfaces today:
 *
 *   - the apps catalog (`useApps` / `prefetchApps`) - public,
 *     session-long cache.
 *   - the user's remote robots (`useRemoteRobots`) - token-scoped,
 *     polled every 30 s.
 *
 * Defaults below are tuned for a Tauri WebView running a single-
 * window app:
 *
 *   - `retry: 1`       - one auto-retry on failure (the network
 *                        is mostly local Wi-Fi or cellular; a
 *                        single retry covers transient hiccups
 *                        without making the user wait through an
 *                        exponential back-off).
 *   - `refetchOnWindowFocus: false` - the WebView doesn't really
 *                        lose / regain focus the way a browser
 *                        tab does; an automatic refetch on every
 *                        return-from-background would burn
 *                        cellular data with no UX gain.
 *   - `staleTime: Infinity` for queries we want truly session-long
 *     (set per-query, not here).
 */
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      retryDelay: 1_000,
      refetchOnWindowFocus: false,
      // Keep cached data alive for the whole JS session by default.
      // Per-query overrides can shorten this (`useRemoteRobots`
      // sets a 30 s polling interval on top of the cache, so its
      // staleness is driven by the poll rather than by GC).
      gcTime: Infinity,
    },
  },
});
