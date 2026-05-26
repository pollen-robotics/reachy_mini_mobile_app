/**
 * View-model hook for the Apps tab.
 *
 * Composes:
 *   - the catalog (`useApps`),
 *   - the user's search query,
 *   - the pinned-id set (`usePinnedApps`),
 *   - the closed taxonomy (`categoryTaxonomy`),
 *
 * into the data shape the UI panels render. The hook is pure
 * derivation: it does not own any state of its own and is safe to
 * mount/unmount freely.
 *
 * Two output modes
 * ────────────────
 * - **Search mode** (`searchQuery.trim() !== ''`): returns a single
 *   flat `searchResults` array. Pinned rail and category rails are
 *   not rendered in this mode (the consumer hides them).
 * - **Browse mode** (empty query): returns `pinned` and the
 *   per-category `rails` (only buckets large enough to be worth
 *   showing). There is no flat "all apps" trailing list: the home
 *   stays focused on pinned + categorical discovery, and the
 *   sparse-bucket apps are reachable via the global search.
 */
import { useMemo } from 'react';

import { type CategoryDescriptor } from './categoryTaxonomy';
import type { AppEntry } from './types';

/**
 * Minimum number of apps for a category rail to be rendered. Below
 * this threshold the category feels barren in a horizontal scroller
 * (single tile + dead space), so we drop it from the home and let
 * those apps surface via search. The threshold is intentionally low
 * so the home still shows breadth: 3 tiles is the smallest size at
 * which the rail's compact-tile arithmetic ("2 fully visible + a
 * peek of the third") actually engages.
 */
export const MIN_RAIL_SIZE = 3;

/**
 * Synthetic descriptor for the "Official apps" rail, prepended
 * before the LLM-driven taxonomy. Lives outside `CATEGORY_TAXONOMY`
 * on purpose: official is a curatorial *facet* on top of the
 * semantic categories (an app is `motion` because of what it does,
 * `official` because of who blesses it), and we don't want to
 * pollute the LLM-driven taxonomy with an editorial flag.
 *
 * The id stays distinct from any real LLM category slug so consumers
 * that key off `descriptor.id` (e.g. drill-down focus mode) can
 * branch reliably on it without colliding with a future taxonomy
 * entry.
 */
export const OFFICIAL_RAIL_ID = 'official' as const;
const OFFICIAL_RAIL_DESCRIPTOR: CategoryDescriptor = {
  id: OFFICIAL_RAIL_ID,
  label: 'Official apps',
};

/**
 * Minimum number of apps for the "Official apps" rail to be
 * rendered. Lower than the generic threshold because the official
 * set is small by design (curated by hand) and the rail carries
 * editorial weight that justifies showing even a single tile -
 * unlike a sparse semantic bucket, an "official" rail with one app
 * still communicates "Pollen vouches for this".
 */
const MIN_OFFICIAL_RAIL_SIZE = 1;

/**
 * Synthetic descriptor for the "Most liked" rail, slotted between
 * the official rail and the LLM-driven semantic rails. Like the
 * official facet, popularity is orthogonal to the semantic
 * taxonomy (an app is `music` because of what it does, "most
 * liked" because of how many ❤s it has on the Hub), so it lives
 * outside `CATEGORY_TAXONOMY` and uses a distinct id namespace
 * from any LLM category slug to avoid collisions in drill-down.
 */
export const MOST_LIKED_RAIL_ID = 'most-liked' as const;
const MOST_LIKED_RAIL_DESCRIPTOR: CategoryDescriptor = {
  id: MOST_LIKED_RAIL_ID,
  label: 'Most liked',
};

/**
 * Hard cap on the "Most liked" rail. The point of the rail is
 * a focused top-of-charts strip, not an alternate paginated index
 * over the whole catalog - 12 tiles is enough horizontal scroll
 * for a flicked swipe to feel discoverable without turning the
 * rail into a second long list. The drill-down ("See all") on
 * this rail therefore shows the same top-N, ordered by likes.
 */
const MOST_LIKED_RAIL_CAP = 12;

/**
 * Likes floor for an app to be eligible for the "Most liked" rail.
 * Apps with 0 likes don't communicate anything ("most liked of the
 * unloved" reads as backhanded), so we keep them out. Anything
 * with ≥ 1 like has at least one human nod and belongs in the
 * popularity strip.
 */
const MOST_LIKED_MIN_LIKES = 1;

/**
 * Minimum bucket size for the "Most liked" rail to render. Matches
 * the generic `MIN_RAIL_SIZE` so the rail only appears when the
 * catalog has enough engagement to fill the "2 tiles + a peek of
 * the third" arithmetic the compact-tile geometry assumes.
 */
const MIN_MOST_LIKED_RAIL_SIZE = MIN_RAIL_SIZE;

interface UseFilteredAppsArgs {
  apps: AppEntry[];
  searchQuery: string;
  pinnedIds: ReadonlySet<string>;
  /**
   * Render-ready taxonomy in render order. Built by the caller via
   * `resolveTaxonomy(catalog.categorization?.taxonomy ?? null)`; we
   * accept it as a prop instead of importing the constant so the
   * data flow is explicit (no hidden coupling to the API shape)
   * and so unit tests can pass any descriptor list without
   * monkey-patching the module.
   */
  taxonomy: ReadonlyArray<CategoryDescriptor>;
}

export interface CategoryBucket {
  /** Taxonomy descriptor (id + label, render order is the array order). */
  descriptor: CategoryDescriptor;
  /** Apps that have this id in their `categories` array. */
  apps: AppEntry[];
}

export interface FilteredApps {
  /** True when the consumer should render the search-results list. */
  isSearching: boolean;
  /** Flat result list, populated only in search mode. */
  searchResults: AppEntry[];
  /** Pinned apps in insertion order, browse mode only. */
  pinned: AppEntry[];
  /**
   * Category rails in render order, browse mode only. Buckets with
   * fewer than `MIN_RAIL_SIZE` apps are dropped (see the constant
   * above for rationale).
   */
  rails: CategoryBucket[];
}

/**
 * Case-insensitive `includes` match on `name + author + description`.
 * Tags are not matched (they have no domain value today; the
 * categorisation is handled server-side via the LLM).
 */
function matchesQuery(app: AppEntry, q: string): boolean {
  if (q.length === 0) return true;
  const haystack = `${app.name}\n${app.author ?? ''}\n${app.description}`.toLowerCase();
  return haystack.includes(q);
}

function sortByLikesDesc(a: AppEntry, b: AppEntry): number {
  return (b.likes || 0) - (a.likes || 0);
}

export function useFilteredApps({
  apps,
  searchQuery,
  pinnedIds,
  taxonomy,
}: UseFilteredAppsArgs): FilteredApps {
  const trimmed = searchQuery.trim().toLowerCase();
  const isSearching = trimmed.length > 0;

  return useMemo<FilteredApps>(() => {
    // Pinned apps in insertion order. Resolved against the
    // catalog so ids that no longer resolve (e.g. an app
    // that was un-published since the user pinned it) drop
    // out silently - the pin entry stays in localStorage but
    // doesn't render. Computed before the search-mode branch
    // because the pinned panel stays visible even while the
    // user is typing: pinned apps are the user's quick-access
    // dock, not part of the result set, so we don't want a
    // search query to hide them.
    const byId = new Map(apps.map((app) => [app.id, app] as const));
    const pinned: AppEntry[] = [];
    for (const id of pinnedIds) {
      const app = byId.get(id);
      if (app) pinned.push(app);
    }

    if (isSearching) {
      const searchResults = apps
        .filter((app) => matchesQuery(app, trimmed))
        .sort(sortByLikesDesc);
      return {
        isSearching: true,
        searchResults,
        pinned,
        rails: [],
      };
    }

    // Per-category bucketing. We iterate the taxonomy in render
    // order so the output `rails` is already correctly ordered
    // and the consumer doesn't need to re-sort. Drop sparse
    // buckets to keep the home focused on rails worth scrolling.
    const rails: CategoryBucket[] = [];

    // "Official apps" rail goes first when non-empty. We sort by
    // likes (same rule as the rest of the rails) so the most loved
    // official apps surface at the head. Apps in this rail also
    // appear in their semantic rail below if they have one - that
    // overlap is intentional, the home is a discovery surface and
    // double exposure is good for browsing.
    const officialBucket = apps
      .filter((app) => app.isOfficial)
      .sort(sortByLikesDesc);
    if (officialBucket.length >= MIN_OFFICIAL_RAIL_SIZE) {
      rails.push({ descriptor: OFFICIAL_RAIL_DESCRIPTOR, apps: officialBucket });
    }

    // "Most liked" rail slots in right below the official one and
    // above the semantic taxonomy: official is editorial ("Pollen
    // says so"), popularity is community-driven ("the crowd says
    // so"), and both deserve to sit above the topical buckets as
    // discovery surfaces. We take the top N apps by like count
    // (with a ≥ 1 floor so 0-like entries don't slip in), then cap
    // to keep the rail focused. Overlap with official / semantic
    // rails is intentional, as it is for the official rail above.
    const mostLikedBucket = apps
      .filter((app) => (app.likes || 0) >= MOST_LIKED_MIN_LIKES)
      .sort(sortByLikesDesc)
      .slice(0, MOST_LIKED_RAIL_CAP);
    if (mostLikedBucket.length >= MIN_MOST_LIKED_RAIL_SIZE) {
      rails.push({
        descriptor: MOST_LIKED_RAIL_DESCRIPTOR,
        apps: mostLikedBucket,
      });
    }

    for (const descriptor of taxonomy) {
      const bucket = apps.filter((app) => app.categories?.includes(descriptor.id));
      if (bucket.length < MIN_RAIL_SIZE) continue;
      bucket.sort(sortByLikesDesc);
      rails.push({ descriptor, apps: bucket });
    }

    return {
      isSearching: false,
      searchResults: [],
      pinned,
      rails,
    };
  }, [apps, isSearching, trimmed, pinnedIds, taxonomy]);
}
