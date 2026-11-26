/**
 * Hub apps the phone replaces with a native surface.
 *
 * The catalog is shared with the desktop app, where these Spaces are the
 * only way in, so they stay listed server-side. On the phone a native tab
 * does the same job over the live session, and listing the Space too
 * shows the feature twice: drop it from the catalog before anything
 * (pins, rails, search) sees it.
 */
const NATIVE_REPLACEMENTS: ReadonlySet<string> = new Set([
  // Telepresence tab (`ui/panels/telepresence`).
  'pollen-robotics/telepresence',
]);

/** True when the phone has its own surface for this catalog app id. */
export function isReplacedByNativeSurface(id: string): boolean {
  return NATIVE_REPLACEMENTS.has(id.toLowerCase());
}
