/**
 * Category taxonomy resolver.
 *
 * The canonical source of truth is the store dataset's
 * `config/taxonomy.json`, loaded by the API server
 * (`reachy_mini_api/server/categories.js`) and shipped to clients
 * in TWO ways:
 *
 *   1. `GET /api/js-apps` → `categorization.taxonomy` (preferred:
 *      one call returns apps + taxonomy together).
 *   2. `GET /api/categories` (standalone, for clients that only
 *      want the slug list, e.g. early UI scaffolding).
 *
 * The mobile shell consumes (1) via `useApps()`, then passes the
 * raw payload through `resolveTaxonomy()` below to obtain the
 * `CategoryDescriptor[]` the UI panels render.
 *
 * Why a resolver instead of a static mirror
 * ─────────────────────────────────────────
 * The previous design kept a hand-edited mirror of the slug list
 * here, which silently drifted from the server every time we
 * bumped `TAXONOMY_VERSION` (e.g. `games` was missing for the
 * whole v2 cycle, `dance` outlived its rename to `motion`).
 * Pulling the taxonomy from the API removes that whole class of
 * bugs.
 *
 * What stays local:
 *   - `LABEL_OVERRIDES`: mobile-preferred short labels for the
 *     rail headers (e.g. server `"Music & Beats"` → mobile
 *     `"Music"`). Labels are a per-surface UI choice, not a
 *     contract: the website and the mobile rails have different
 *     space constraints, so we don't force them to share a value.
 *   - `FALLBACK_TAXONOMY`: a snapshot of the live taxonomy used
 *     when the API hasn't responded yet (cold start, offline,
 *     transient failure). Keeping a typed fallback means the rail
 *     order on first paint matches what the user will see post-
 *     hydration, instead of a flash of blank rails.
 *
 * Bumping the local fallback
 * ──────────────────────────
 * When you intentionally bump the server taxonomy AND ship a
 * mobile build in the same release, update `FALLBACK_TAXONOMY`
 * to mirror the new slug list. It's not strictly required (the
 * API will hand over the live taxonomy on first refresh anyway),
 * but it keeps the first-paint experience honest. Forgetting to
 * update it is a cosmetic bug, not a correctness bug.
 */
import type { ApiCategoryEntry } from './types';

export interface CategoryDescriptor {
  /** Server-side taxonomy id (matches the `categories` array on `AppEntry`). */
  id: string;
  /** Human-readable display label rendered in the rail header. */
  label: string;
}

/**
 * Mobile-side label overrides, keyed by server slug. Lets us keep
 * shorter, rail-friendly labels (the website chooses longer ones
 * for SEO + filter chips) without forcing the server to publish
 * two label variants. Missing slugs fall back to the server label
 * unchanged.
 */
const LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  voice: 'Voice & Chat',
  motion: 'Motion',
  music: 'Music',
  storytelling: 'Stories',
  vision: 'Vision',
  companion: 'Companions',
  kids: 'Kids',
  games: 'Games',
  'dev-tools': 'Demos & Dev',
};

/**
 * Cold-start fallback. Mirrors the live server taxonomy
 * (`config/taxonomy.json`, version 4 at the time of this snapshot)
 * in the SAME render order, so the first paint matches what the
 * user sees post-hydration (no rail re-ordering flash). The render
 * order is owned by the server: it's the order of the categories in
 * `config/taxonomy.json` (`music → motion → voice → storytelling →
 * kids → games → vision → companion → dev-tools`). Keep this array
 * in lockstep with that order when you bump the dataset taxonomy.
 */
const FALLBACK_TAXONOMY: ReadonlyArray<CategoryDescriptor> = [
  { id: 'music', label: 'Music' },
  { id: 'motion', label: 'Motion' },
  { id: 'voice', label: 'Voice & Chat' },
  { id: 'storytelling', label: 'Stories' },
  { id: 'kids', label: 'Kids' },
  { id: 'games', label: 'Games' },
  { id: 'vision', label: 'Vision' },
  { id: 'companion', label: 'Companions' },
  { id: 'dev-tools', label: 'Demos & Dev' },
] as const;

/**
 * Resolve the live taxonomy to consume in the UI.
 *
 * Pure derivation:
 *   - If the API payload is present, take the slug + order from
 *     the server (single source of truth) and apply mobile label
 *     overrides on top.
 *   - Otherwise, return the local fallback so the home view can
 *     render rails before the network call completes.
 *
 * The function is referentially stable for unchanged inputs only
 * when the caller memoises around it (we don't intern the result
 * here on purpose: callers typically wrap it in `useMemo` already).
 */
export function resolveTaxonomy(
  apiTaxonomy: readonly ApiCategoryEntry[] | null | undefined,
): ReadonlyArray<CategoryDescriptor> {
  if (!apiTaxonomy || apiTaxonomy.length === 0) {
    return FALLBACK_TAXONOMY;
  }
  const seen = new Set<string>();
  const out: CategoryDescriptor[] = [];
  for (const entry of apiTaxonomy) {
    if (!entry || typeof entry.slug !== 'string') continue;
    const slug = entry.slug.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const override = LABEL_OVERRIDES[slug];
    const serverLabel =
      typeof entry.label === 'string' && entry.label.trim().length > 0
        ? entry.label
        : slug;
    out.push({ id: slug, label: override ?? serverLabel });
  }
  return out.length > 0 ? out : FALLBACK_TAXONOMY;
}

/**
 * Cold-start descriptor list (legacy export). Kept so callers that
 * cannot reach the API yet (e.g. unit tests, storybook stubs) can
 * still get a sensible default. Prefer `resolveTaxonomy(apiTaxonomy)`
 * in runtime code paths.
 */
export const CATEGORY_TAXONOMY: ReadonlyArray<CategoryDescriptor> =
  FALLBACK_TAXONOMY;

/** Set of known ids from the local fallback, useful for sanity checks. */
export const KNOWN_CATEGORY_IDS: ReadonlySet<string> = new Set(
  FALLBACK_TAXONOMY.map((c) => c.id),
);

/**
 * Look up a category descriptor by id in a resolved taxonomy. Returns
 * `null` for unknown ids (which a future server taxonomy bump may
 * emit ahead of a mobile release if the fallback is consulted); the
 * consumer drops the entry silently.
 */
export function getCategoryDescriptor(
  taxonomy: ReadonlyArray<CategoryDescriptor>,
  id: string,
): CategoryDescriptor | null {
  return taxonomy.find((c) => c.id === id) ?? null;
}
