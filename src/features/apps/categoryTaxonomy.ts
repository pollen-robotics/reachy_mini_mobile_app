/**
 * Category taxonomy mirror.
 *
 * The canonical source of truth lives on the website server
 * (`reachy-mini-website/server/categories.js`); this file is the
 * **passive mobile-side mirror** that maps each id to its display
 * label and render order. No emoji on the rail header (decided
 * during design review) - emojis stay on per-app tiles only, where
 * they come from the author's `cardData.emoji`.
 *
 * See `docs/APPS_TAB_REDESIGN.md`, Section 5.2 for the contract.
 *
 * Adding or renaming a category requires a coordinated change:
 *   1. Update the server taxonomy + LLM prompt (bumps
 *      `taxonomyVersion` in the API payload).
 *   2. Update this mirror.
 *   3. Ship the mobile build.
 *
 * Steps 1 and 2 are independent in time:
 *   - Server taxonomy bump without a mobile build → unknown ids
 *     are silently dropped (apps still surface in "ALL APPS"
 *     and search).
 *   - Mobile build referencing an id the server hasn't started
 *     using → the bucket is empty, the rail vanishes.
 */
export interface CategoryDescriptor {
  /** Server-side taxonomy id (matches the `categories` array on `AppEntry`). */
  id: string;
  /** Human-readable display label rendered in the rail header. */
  label: string;
}

/**
 * Render order = order of this array.
 *
 * V1 surfaces consumer-facing rails first (voice → dance → music
 * → stories → vision → companion → kids), then pushes the largest
 * but least consumer-friendly bucket (`dev-tools`, ~1/3 of the
 * catalog) to the bottom so the home view leads with apps users
 * are most likely to launch.
 */
export const CATEGORY_TAXONOMY: ReadonlyArray<CategoryDescriptor> = [
  { id: 'voice', label: 'Voice & Chat' },
  { id: 'dance', label: 'Dance' },
  { id: 'music', label: 'Music' },
  { id: 'storytelling', label: 'Stories' },
  { id: 'vision', label: 'Vision' },
  { id: 'companion', label: 'Companions' },
  { id: 'kids', label: 'Kids' },
  { id: 'dev-tools', label: 'Demos & Dev' },
] as const;

/** Set of known ids, useful for O(1) membership checks when filtering. */
export const KNOWN_CATEGORY_IDS: ReadonlySet<string> = new Set(
  CATEGORY_TAXONOMY.map((c) => c.id),
);

/**
 * Look up a category descriptor by id. Returns `null` for unknown
 * ids (which a future server taxonomy bump may emit ahead of a
 * mobile release); the consumer drops the entry silently.
 */
export function getCategoryDescriptor(id: string): CategoryDescriptor | null {
  return CATEGORY_TAXONOMY.find((c) => c.id === id) ?? null;
}
