/**
 * Fetch the Reachy apps owned by the signed-in user, straight from
 * the HF Hub (NOT the public `/api/js-apps` catalog).
 *
 * Why hit the Hub directly instead of the catalog?
 * ────────────────────────────────────────────────
 * The catalog served by `reachy_mini_api` is a public, token-less,
 * shared snapshot of every `reachy_mini`-tagged Space. It therefore
 * cannot surface the user's PRIVATE or not-yet-indexed Spaces. Here
 * we authenticate with the user's OAuth bearer (same token the like
 * UX uses, see `likesApi.ts`) and query the Hub's per-author Spaces
 * endpoint, which returns private repos the caller owns.
 *
 *   GET https://huggingface.co/api/spaces?author={username}&full=true
 *
 * We then keep only the Spaces tagged `reachy_mini_js_app` (the
 * subset the mobile shell can actually iframe) and normalise them
 * into the same `AppEntry` shape the catalog produces, reusing
 * `normalizeApp` so the rail tiles render identically to the rest
 * of the store.
 */
import type { AppEntry } from './types';
import { normalizeApp, type RawCatalogApp } from './useApps';

const HF_BASE = 'https://huggingface.co';

/**
 * Tag gating the JS-embeddable subset. Mirrors the filter applied
 * server-side by `reachy_mini_api` (`JS_APP_TAG`) so "Your apps"
 * shows the same class of apps the rest of the store can launch.
 */
const JS_APP_TAG = 'reachy_mini_js_app';

/** Conventional in-repo icon locations, SVG preferred (see catalog). */
const ICON_CANDIDATES = ['public/icon.svg', 'public/icon.png'];

interface RawHfSpace {
  id?: string;
  author?: string;
  likes?: number;
  sdk?: string;
  tags?: string[];
  cardData?: {
    title?: string;
    short_description?: string;
    sdk?: string;
    emoji?: string;
    tags?: string[];
  };
  siblings?: Array<{ rfilename?: string }>;
}

/**
 * Resolve the conventional app icon URL from the Space file list,
 * matching the server-side resolution in `reachy_mini_api`. Returns
 * an absolute HF `resolve/main/` URL or `null` when no icon ships.
 */
function resolveIconUrl(spaceId: string, siblings: RawHfSpace['siblings']): string | null {
  if (!spaceId || !Array.isArray(siblings)) return null;
  const files = new Set(
    siblings
      .map((s) => s?.rfilename)
      .filter((f): f is string => typeof f === 'string'),
  );
  for (const candidate of ICON_CANDIDATES) {
    if (files.has(candidate)) {
      return `${HF_BASE}/spaces/${spaceId}/resolve/main/${candidate}`;
    }
  }
  return null;
}

/** True iff the Space carries the JS-app tag (top-level or cardData). */
function isReachyJsApp(space: RawHfSpace): boolean {
  const tags = [...(space.tags ?? []), ...(space.cardData?.tags ?? [])];
  return tags.includes(JS_APP_TAG);
}

/**
 * Map a raw HF Hub Space object into the `RawCatalogApp` shape
 * `normalizeApp` expects (SDK / emoji / title live under
 * `extra.cardData`), then normalise.
 */
function spaceToAppEntry(space: RawHfSpace): AppEntry | null {
  const id = space.id;
  if (!id) return null;
  const raw: RawCatalogApp = {
    id,
    name: id.split('/').pop(),
    author: space.author,
    likes: space.likes,
    tags: space.tags,
    iconUrl: resolveIconUrl(id, space.siblings),
    extra: {
      id,
      author: space.author,
      likes: space.likes,
      tags: space.tags,
      sdk: space.sdk,
      cardData: space.cardData,
    },
  };
  return normalizeApp(raw);
}

/**
 * Fetch the user's own Reachy JS apps (private repos included).
 *
 * @param token    HF OAuth bearer (from `useRemoteHfToken`).
 * @param username HF username whose Spaces we list.
 */
export async function fetchMyReachyApps(
  token: string,
  username: string,
): Promise<AppEntry[]> {
  const url = `${HF_BASE}/api/spaces?author=${encodeURIComponent(
    username,
  )}&full=true&limit=100`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) {
    throw new Error(`HF GET /api/spaces?author=${username} HTTP ${resp.status}`);
  }
  const payload = (await resp.json()) as unknown;
  const spaces: RawHfSpace[] = Array.isArray(payload) ? payload : [];
  const out: AppEntry[] = [];
  for (const space of spaces) {
    if (!isReachyJsApp(space)) continue;
    const entry = spaceToAppEntry(space);
    if (entry) out.push(entry);
  }
  return out;
}
