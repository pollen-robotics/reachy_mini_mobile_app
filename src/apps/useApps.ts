/**
 * Apps catalog hook.
 *
 * Single source: the curated catalog served by the public Reachy
 * Mini website Space:
 *
 *   GET https://pollen-robotics-reachy-mini.hf.space/api/apps
 *
 * The desktop app augments this with a daemon-local catalog
 * (installed apps), but mobile never installs apps - we only ever
 * iframe them at their HF Space runtime URL. So a single fetch +
 * minimal normalization is enough.
 *
 * Caching strategy is intentionally short (5 minutes) so the user
 * gets up-to-date listings when they re-enter the Apps tab without
 * paying a network round-trip every render.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AppEntry, AppSdk } from './types';

const WEBSITE_API_URL = 'https://pollen-robotics-reachy-mini.hf.space/api/apps';
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Tag that marks a catalog entry as a JS-only Reachy Mini app the
 * mobile shell can iframe. The website catalog is heterogeneous
 * (Python apps, Docker apps, daemon-installed apps, …) but only the
 * `reachy_mini_js_app`-tagged ones run as a static HF Space we can
 * embed without needing the daemon to host a Python runtime.
 *
 * Filtering at the source keeps every downstream consumer (the apps
 * tab, the iframe overlay, future search/sort UIs) on the same
 * curated subset - there's exactly one place to change the contract.
 */
const REQUIRED_APP_TAG = 'reachy_mini_js_app';

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
  tags?: string[];
  likes?: number;
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

interface RawCatalogPayload {
  apps?: RawCatalogApp[];
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
  return {
    id,
    name,
    description,
    spaceUrl,
    author,
    isOfficial,
    sdk,
    emoji,
    tags: Array.from(new Set(tags)),
    likes,
    extra: (raw.extra as Record<string, unknown>) ?? {},
  };
}

function normalizeCatalog(payload: unknown): AppEntry[] {
  const raw = Array.isArray(payload)
    ? (payload as RawCatalogApp[])
    : ((payload as RawCatalogPayload | null)?.apps ?? []);
  const apps: AppEntry[] = [];
  for (const r of raw) {
    const normalized = normalizeApp(r);
    if (!normalized) continue;
    // Mobile-only filter: drop entries that don't carry the
    // JS-app tag. The mobile shell can't host Python apps - it
    // iframes static HF Spaces, period - so unfiltered entries
    // would render in the Apps tab as broken iframes (or worse,
    // load a desktop-only flow that needs a daemon proxy).
    if (!normalized.tags.includes(REQUIRED_APP_TAG)) continue;
    apps.push(normalized);
  }
  return apps;
}

interface CacheSlot {
  apps: AppEntry[];
  fetchedAt: number;
}

let moduleCache: CacheSlot | null = null;

export type AppsState =
  | { kind: 'idle' }
  | { kind: 'loading'; apps: AppEntry[] }
  | { kind: 'ready'; apps: AppEntry[] }
  | { kind: 'error'; reason: string; apps: AppEntry[] };

interface UseAppsReturn {
  state: AppsState;
  refresh: () => Promise<void>;
}

/**
 * Fetch the public Reachy Mini apps catalog with a 5-minute
 * module-level cache. The cache is shared across components, so
 * multiple `useApps()` consumers share a single network call.
 */
export function useApps(): UseAppsReturn {
  const [state, setState] = useState<AppsState>(() => {
    if (moduleCache && Date.now() - moduleCache.fetchedAt < CACHE_TTL_MS) {
      return { kind: 'ready', apps: moduleCache.apps };
    }
    return { kind: 'idle' };
  });
  const inFlightRef = useRef<Promise<void> | null>(null);

  const fetchOnce = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    const previous =
      state.kind === 'ready' || state.kind === 'error' ? state.apps : [];
    setState({ kind: 'loading', apps: previous });
    const run = (async () => {
      try {
        const res = await fetch(WEBSITE_API_URL, { credentials: 'omit' });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = (await res.json()) as unknown;
        const apps = normalizeCatalog(payload);
        moduleCache = { apps, fetchedAt: Date.now() };
        setState({ kind: 'ready', apps });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', reason, apps: previous });
      } finally {
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = run;
    return run;
    // We deliberately omit `state` from the dep list - it would
    // create a new callback on every render and cause an infinite
    // refresh loop in the effect below. The previous-list snapshot
    // is captured at call time, which is what we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state.kind === 'idle') {
      void fetchOnce();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, refresh: fetchOnce };
}
