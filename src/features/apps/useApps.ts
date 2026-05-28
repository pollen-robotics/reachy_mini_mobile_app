/**
 * Apps catalog hook (TanStack Query).
 *
 * Single source: the curated catalog served by the public Reachy
 * Mini website Space:
 *
 *   GET https://pollen-robotics-reachy-mini.hf.space/api/js-apps
 *
 * The endpoint pre-filters JS apps server-side (so we no longer
 * filter on the `reachy_mini_js_app` tag client-side) and attaches
 * a `categories` array per app classified by an LLM running on the
 * website Space. The shape we consume is documented in
 * `docs/APPS_TAB_REDESIGN.md`, Section 5.1.
 *
 * The desktop app augments a richer catalog with a daemon-local
 * (installed apps) view, but mobile never installs apps - we only
 * ever iframe them at their HF Space runtime URL. So a single fetch
 * + minimal normalization is enough.
 *
 * Caching strategy: short-staleness + opportunistic revalidation.
 * ────────────────────────────────────────────
 * The catalog rarely changes within a session, but it CAN change
 * (an upstream Space migrates its SDK from docker→static, a new
 * app gets listed, an app gets renamed), and a permanently stale
 * cache makes those changes invisible until the user manually
 * taps "refresh" or cold-starts the shell. Through TanStack
 * Query we get:
 *
 *   1. A single shared cache slot keyed by `APPS_QUERY_KEY` -
 *      every `useApps()` consumer subscribes to it, every
 *      `prefetchApps()` writes into it, no double fetches.
 *   2. `staleTime: 5 min` - the data is treated as fresh for
 *      5 minutes. Inside that window, mounting / focusing /
 *      reconnecting NEVER triggers a refetch (zero useless
 *      traffic during normal interactive use). Past the window,
 *      we let the natural triggers below revalidate the cache
 *      WITHOUT polling - no `refetchInterval`, no thundering
 *      herd at scale.
 *   3. `refetchOnWindowFocus: 'always'` - when the user puts the
 *      app in the background and brings it back, we revalidate
 *      the catalog. Combined with `staleTime: 5min`, this means
 *      a one-tap focus inside the 5-minute window costs nothing
 *      (TanStack treats data as fresh and skips the fetch),
 *      while a focus after a longer pause re-pulls the catalog
 *      ahead of the user's next interaction.
 *   4. `refetchOnReconnect: 'always'` - same idea for the
 *      offline→online edge: when the device regains connectivity,
 *      we revalidate whatever it tried to view offline. Reuses
 *      the freshness window so a brief network blip doesn't
 *      trigger an extra fetch.
 *   5. `refetch()` for the explicit "Refresh" button on the Apps
 *      tab. Keeps the previous list visible while the refetch is
 *      in flight (`isFetching`), so a transient hub hiccup
 *      doesn't blank the surface.
 *
 * Self-healing fallback: the iframe overlay (`AppIframeOverlay`)
 * has a Couche-2 recovery that invalidates this cache and retries
 * once on iframe-load failures, so an SDK migration that happens
 * mid-session still self-corrects without waiting for the
 * 5-minute staleness window.
 *
 * Scale note: ~10k clients × ~5 focus/reconnect refetches/day ≈
 * 50k req/day on `/api/js-apps`, spread organically by user
 * activity (not synchronised to a server timer). The endpoint
 * sets `Cache-Control: max-age=60, stale-while-revalidate=300`
 * AND emits a stable ETag, so the vast majority of those
 * revalidations are cheap 304s.
 *
 * Public endpoint - no token, no credentials. Safe to prefetch
 * even before the auth gate.
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import { queryClient } from '@/queryClient';

import { prefetchAppIcons } from './iconCache';
import type {
  ApiCategoryEntry,
  AppEntry,
  AppSdk,
  CategorizationMeta,
} from './types';

const WEBSITE_API_URL = 'https://pollen-robotics-reachy-mini.hf.space/api/js-apps';

/**
 * TanStack Query cache key for the catalog. Stable, no params.
 * Exported so reactive call sites outside this module (e.g. the
 * iframe overlay's self-healing path on a failed embed load) can
 * invalidate / refetch / read the catalog without re-stating the
 * literal and risking a typo drift.
 */
export const APPS_QUERY_KEY = ['js-apps-catalog'] as const;

/**
 * Freshness window for the catalog query. Past this point a
 * mount / focus / reconnect will trigger a revalidation; inside
 * it those triggers are no-ops.
 *
 * Tuning rationale: 5 minutes mirrors the server-side cache TTL
 * (`CACHE_TTL_MS` in `reachy-mini-website/server/index.js`) so a
 * client that revalidates "just past stale" usually hits the
 * server's still-warm cache and gets a free 304 on the conditional
 * GET. Shorter and we'd serve more 304s but also pay TLS overhead
 * for nothing; longer and SDK migrations would stay invisible too
 * long after a focus event.
 */
const APPS_STALE_TIME_MS = 5 * 60 * 1000;

interface RawCatalogApp {
  id?: string;
  name?: string;
  description?: string;
  url?: string | null;
  author?: string;
  organization?: string;
  org?: string;
  owner?: string;
  isOfficial?: boolean;
  /**
   * Server-resolved icon URL. Set by the catalog when the Space
   * ships `icon.svg` / `icon.png` at the repo root; absent or
   * `null` otherwise. We accept both spellings for forward
   * compatibility with a possible `icon_url` snake-case variant.
   */
  iconUrl?: string | null;
  icon_url?: string | null;
  tags?: string[];
  likes?: number;
  categories?: string[] | null;
  categories_source?: string | null;
  categorized_at?: string | null;
  extra?: {
    id?: string;
    repo_id?: string;
    repoId?: string;
    space_id?: string;
    spaceId?: string;
    app_id?: string;
    appId?: string;
    author?: string;
    tags?: string[];
    likes?: number;
    cardData?: {
      title?: string;
      short_description?: string;
      sdk?: string;
      emoji?: string;
      tags?: string[];
    };
    sdk?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface RawApiCategoryEntry {
  slug?: string;
  label?: string;
  emoji?: string | null;
  order?: number | null;
}

interface RawCategorizationMeta {
  enabled?: boolean;
  total?: number;
  classified?: number;
  pending?: number;
  inProgress?: boolean;
  dataset?: string | null;
  taxonomyVersion?: number | null;
  taxonomy?: RawApiCategoryEntry[] | null;
}

interface RawCatalogPayload {
  apps?: RawCatalogApp[];
  categorization?: RawCategorizationMeta;
}

/**
 * Catalog payload after normalization. We hold both the per-app
 * list and the top-level `categorization` meta so the UI can
 * surface a "classifying..." chip when the server is mid-batch.
 *
 * Exported because consumers that read the cache directly via
 * `queryClient.getQueryData(APPS_QUERY_KEY)` (the iframe overlay's
 * self-healing path) need the type at the call site - without it,
 * the recovery code couldn't pluck the up-to-date `AppEntry` for
 * a given id after a refetch.
 */
export interface CatalogPayload {
  apps: AppEntry[];
  categorization: CategorizationMeta | null;
}

function pickFirstString(values: Array<unknown>): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return null;
}

/**
 * Resolve a stable, namespaced (`<author>/<repo>`) id from the
 * heterogeneous catalog payload. Falls back to the bare `id` /
 * `name` only when no namespaced candidate is present.
 */
function resolveAppId(raw: RawCatalogApp): string | null {
  const candidates = [
    raw.extra?.id,
    raw.extra?.repo_id,
    raw.extra?.repoId,
    raw.extra?.space_id,
    raw.extra?.spaceId,
    raw.extra?.app_id,
    raw.extra?.appId,
    raw.id,
    (raw as { repo_id?: string }).repo_id,
    (raw as { space_id?: string }).space_id,
  ];
  const namespaced = candidates.find(
    (v): v is string => typeof v === 'string' && v.includes('/'),
  );
  if (namespaced) return namespaced;
  const bare = pickFirstString(candidates);
  if (!bare) return null;
  const author = pickFirstString([
    raw.extra?.author,
    raw.author,
    raw.organization,
    raw.org,
    raw.owner,
  ]);
  return author ? `${author}/${bare}` : bare;
}

function normalizeApp(raw: RawCatalogApp): AppEntry | null {
  const id = resolveAppId(raw);
  if (!id) return null;
  const author =
    pickFirstString([
      raw.extra?.author,
      raw.author,
      raw.organization,
      raw.org,
      raw.owner,
    ]) ?? id.split('/')[0] ?? null;
  // Prefer the curated `cardData.title` (e.g. "Reachy Mini Conversation App")
  // over the raw repo slug (`reachy_mini_conversation_app`); falls back
  // to the slug last so we always have something to render.
  const name =
    pickFirstString([raw.extra?.cardData?.title, raw.name]) ??
    id.split('/').pop() ??
    id;
  const description =
    pickFirstString([
      raw.description,
      raw.extra?.cardData?.short_description,
    ]) ?? '';
  const spaceUrl =
    pickFirstString([raw.url]) ?? `https://huggingface.co/spaces/${id}`;
  const tags: string[] = [
    ...(raw.tags ?? []),
    ...(raw.extra?.tags ?? []),
    ...(raw.extra?.cardData?.tags ?? []),
  ];
  const likes =
    typeof raw.likes === 'number'
      ? raw.likes
      : typeof raw.extra?.likes === 'number'
        ? raw.extra.likes
        : 0;
  const isOfficial =
    typeof raw.isOfficial === 'boolean'
      ? raw.isOfficial
      : author === 'pollen-robotics';
  // The HF Hub exposes the Space's SDK in two slightly different
  // places depending on the catalog source: `extra.cardData.sdk`
  // for entries hydrated from the Space's README front-matter,
  // `extra.sdk` for entries that go through the `/api/spaces`
  // direct path. Anything other than `static` collapses to `other`
  // because the runtime-URL fork in `buildAppEmbedUrl()` only
  // distinguishes `static` from everything else (the latter all
  // share `*.hf.space`).
  const rawSdk = pickFirstString([raw.extra?.cardData?.sdk, raw.extra?.sdk]);
  const sdk: AppSdk = rawSdk === 'static' ? 'static' : 'other';
  // Author-chosen emoji from the Space's README front-matter
  // (`emoji: 🎵`). Catalog hydrates it on `extra.cardData.emoji`.
  // Trimmed because some entries pad with a leading space; left
  // null when missing so the renderer can fall back to a generic
  // icon without a sentinel string check.
  const emoji = pickFirstString([raw.extra?.cardData?.emoji])?.trim() || null;
  // Server-resolved app icon URL (Space ships `icon.svg`/`icon.png`
  // at repo root). Catalog publishes it as a top-level `iconUrl`;
  // we also accept `icon_url` for forward compatibility. Trimmed
  // and validated to a plausible HF resolve URL; anything else
  // falls back to `null` so renderers reach for the emoji glyph
  // instead of rendering a broken image.
  const iconUrlRaw = pickFirstString([raw.iconUrl, raw.icon_url]);
  const iconUrl =
    iconUrlRaw && /^https?:\/\//i.test(iconUrlRaw) ? iconUrlRaw : null;
  // Categories: keep them as-is (multi-valued strings). Defensive:
  // some servers may emit `null`, an empty array, or even a single
  // string; we normalise to `string[] | null`.
  let categories: string[] | null = null;
  if (Array.isArray(raw.categories)) {
    const cleaned = raw.categories.filter(
      (c): c is string => typeof c === 'string' && c.trim().length > 0,
    );
    categories = cleaned.length > 0 ? cleaned : null;
  } else if (typeof raw.categories === 'string') {
    const trimmed = (raw.categories as string).trim();
    categories = trimmed.length > 0 ? [trimmed] : null;
  }
  const categoriesSource = pickFirstString([raw.categories_source]);
  const categorizedAt = pickFirstString([raw.categorized_at]);
  return {
    id,
    name,
    description,
    spaceUrl,
    author,
    isOfficial,
    sdk,
    emoji,
    iconUrl,
    tags: Array.from(new Set(tags)),
    likes,
    categories,
    categoriesSource,
    categorizedAt,
    extra: (raw.extra as Record<string, unknown>) ?? {},
  };
}

/**
 * Normalize the raw `categorization.taxonomy` array shipped by the
 * server (`getPublicTaxonomy()`). Defensive: a pre-taxonomy build
 * omits the field, a malformed payload may include entries with
 * missing slugs - we drop those silently. Returns `null` when the
 * server didn't ship a taxonomy at all so the consumer
 * (`resolveTaxonomy()`) can fall back to the local snapshot.
 */
function normalizeTaxonomy(
  raw: RawApiCategoryEntry[] | null | undefined,
): readonly ApiCategoryEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: ApiCategoryEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry.slug !== 'string') continue;
    const slug = entry.slug.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const label =
      typeof entry.label === 'string' && entry.label.trim().length > 0
        ? entry.label
        : slug;
    out.push({
      slug,
      label,
      emoji: typeof entry.emoji === 'string' ? entry.emoji : null,
      order: typeof entry.order === 'number' ? entry.order : null,
    });
  }
  return out.length > 0 ? out : null;
}

function normalizeCategorization(
  raw: RawCategorizationMeta | undefined,
): CategorizationMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    enabled: raw.enabled === true,
    total: typeof raw.total === 'number' ? raw.total : 0,
    classified: typeof raw.classified === 'number' ? raw.classified : 0,
    pending: typeof raw.pending === 'number' ? raw.pending : 0,
    inProgress: raw.inProgress === true,
    dataset: typeof raw.dataset === 'string' ? raw.dataset : null,
    taxonomyVersion:
      typeof raw.taxonomyVersion === 'number' ? raw.taxonomyVersion : null,
    taxonomy: normalizeTaxonomy(raw.taxonomy),
  };
}

/**
 * Normalize the raw catalog payload into apps + meta. Exported for
 * unit tests; the runtime path goes through `useQuery`.
 */
export function normalizeCatalog(payload: unknown): CatalogPayload {
  const raw = Array.isArray(payload)
    ? ({ apps: payload as RawCatalogApp[] } as RawCatalogPayload)
    : ((payload as RawCatalogPayload | null) ?? {});
  const apps: AppEntry[] = [];
  for (const r of raw.apps ?? []) {
    const normalized = normalizeApp(r);
    if (normalized) apps.push(normalized);
  }
  return {
    apps,
    categorization: normalizeCategorization(raw.categorization),
  };
}

async function fetchAppsCatalog(): Promise<CatalogPayload> {
  const res = await fetch(WEBSITE_API_URL, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = (await res.json()) as unknown;
  const catalog = normalizeCatalog(payload);
  // Warm the browser's image cache for every custom app icon as
  // soon as the catalog lands. Uses `new Image()` (same loader
  // path as the `<img>` element rendered later in the tile),
  // which avoids the CORS race that would happen with `fetch()`.
  // No-op for apps without a custom icon.
  prefetchAppIcons(catalog.apps.map((a) => a.iconUrl));
  return catalog;
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Public state shape consumed by `<AppsTabView>`. Discriminated
 * union so the consumer can branch on `state.kind` without
 * counting boolean flags.
 *
 * `apps` is always present (defaults to `[]` on idle/loading) so
 * downstream view-model hooks can run unconditionally. `categorization`
 * is `null` until the first successful fetch.
 */
export type AppsState =
  | { kind: 'idle'; apps: AppEntry[]; categorization: CategorizationMeta | null }
  | { kind: 'loading'; apps: AppEntry[]; categorization: CategorizationMeta | null }
  | { kind: 'ready'; apps: AppEntry[]; categorization: CategorizationMeta | null }
  | {
      kind: 'error';
      reason: string;
      apps: AppEntry[];
      categorization: CategorizationMeta | null;
    };

interface UseAppsReturn {
  state: AppsState;
  refresh: () => Promise<void>;
}

/**
 * Warm the catalog cache. Idempotent: TanStack Query dedupes
 * concurrent prefetches against the same key, and re-prefetching
 * a fresh query is a free no-op.
 *
 * Call this from the App root (or use `usePrefetchApps()`) so the
 * catalog is ready by the time the user navigates to the Apps tab.
 */
export function prefetchApps(): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: APPS_QUERY_KEY,
    queryFn: fetchAppsCatalog,
    // Same staleness window as `useApps()` below. The prefetch
    // path MUST agree with the live query, otherwise a prefetch
    // from the app root would mark the entry "fresh forever" and
    // suppress the very revalidations `useApps()` is configured
    // to perform.
    staleTime: APPS_STALE_TIME_MS,
  });
}

/**
 * Hook variant of `prefetchApps()`. Designed to live at the App
 * root: fires the prefetch on mount and forgets.
 */
export function usePrefetchApps(): void {
  useEffect(() => {
    void prefetchApps();
  }, []);
}

/**
 * Subscribe to the apps catalog. Returns a discriminated state
 * + a `refresh()` action for the explicit "reload" button.
 *
 * Mounting `useApps()` triggers the underlying query, which
 * dedupes against any concurrent `prefetchApps()` (App-root
 * warm-up) so consumers always share a single network call.
 */
export function useApps(): UseAppsReturn {
  const query = useQuery({
    queryKey: APPS_QUERY_KEY,
    queryFn: fetchAppsCatalog,
    // See the file-level "Caching strategy" comment for the
    // rationale on these three values. Short version:
    //   - 5 min staleness means inside that window no event
    //     trigger costs a network round-trip.
    //   - `always` on focus/reconnect so that past the freshness
    //     window we re-pull the catalog ahead of the user's next
    //     interaction, without polling.
    staleTime: APPS_STALE_TIME_MS,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });

  const apps = query.data?.apps ?? [];
  const categorization = query.data?.categorization ?? null;

  let state: AppsState;
  if (query.isFetching && apps.length === 0) {
    state = { kind: 'loading', apps: [], categorization };
  } else if (query.isFetching) {
    // Refresh in-flight with a previous list available - keep it
    // visible so the surface doesn't blank.
    state = { kind: 'loading', apps, categorization };
  } else if (query.isError) {
    state = {
      kind: 'error',
      reason:
        query.error instanceof Error
          ? query.error.message
          : String(query.error),
      apps,
      categorization,
    };
  } else if (query.isSuccess) {
    state = { kind: 'ready', apps, categorization };
  } else {
    // Pre-fetch resting state (very brief: TanStack Query goes to
    // `isFetching` on mount). The discriminated `idle` keeps the
    // public type stable for consumers that branch on it.
    state = { kind: 'idle', apps: [], categorization };
  }

  const refresh = async (): Promise<void> => {
    await query.refetch();
  };

  return { state, refresh };
}
