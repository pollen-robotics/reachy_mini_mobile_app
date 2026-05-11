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

import { CATEGORY_TAXONOMY, type CategoryDescriptor } from './categoryTaxonomy';
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

interface UseFilteredAppsArgs {
  apps: AppEntry[];
  searchQuery: string;
  pinnedIds: ReadonlySet<string>;
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
    for (const descriptor of CATEGORY_TAXONOMY) {
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
  }, [apps, isSearching, trimmed, pinnedIds]);
}
