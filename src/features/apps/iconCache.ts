/**
 * App icon preload cache.
 *
 * Goal
 * ────
 * Hugging Face's `resolve/main/` URL chain does NOT set
 * `Cache-Control`. Every `<img>` mount of an app icon triggers a
 * 307 redirect + a conditional GET, with a visible "reload" flash
 * on every tab switch.
 *
 * Approach
 * ────────
 * Trigger an `Image()` preload for each iconUrl as soon as the
 * catalog payload arrives. This uses the EXACT same browser loader
 * pipeline as `<img src=...>` so:
 *
 *   - No CORS preflight (image requests are no-cors by default).
 *   - No race condition with `<img>` elements rendered later:
 *     they share the same in-flight request, and a previous fetch
 *     leaves a memory-cache entry the next `<img>` instantly hits.
 *
 * Why not `fetch()` + Blob URL
 * ────────────────────────────
 * The fetch path uses CORS mode. When we ran it in parallel with
 * a no-CORS `<img>` to the same URL, Safari WebKit fired
 * `onError` on the `<img>` and locked the component into the
 * emoji fallback. `Image()` shares the loader with `<img>` so the
 * race vanishes.
 *
 * What this gives us
 * ──────────────────
 *   - Cold catalog load: prefetch fires for every iconUrl; bytes
 *     stream in while the user is still on other tabs. By the
 *     time they navigate to Apps, most icons paint without a
 *     network roundtrip.
 *   - Tab switch (re-mount within ~5 min): browser still has the
 *     decoded bitmap in memory; `<img>` paints synchronously, no
 *     reload flash.
 *   - Long absence from the tab (browser evicts cache): worst
 *     case is one ETag revalidation roundtrip per icon, same as
 *     today.
 *
 * Memory budget
 * ─────────────
 * Each preloaded image is held by an `Image` JS object that
 * persists for the session (we never null the reference). 30
 * apps × ~80 KB SVG = ~2.4 MB worst case, kept alive as long as
 * the JS context lives. Reclaimed on full reload.
 */
const preloaded = new Map<string, HTMLImageElement>();

/**
 * Trigger an `Image()` preload for the given URL. Idempotent:
 * repeated calls for the same URL are no-ops.
 *
 * The returned `Image` reference is kept alive in the module
 * cache so the browser's image cache entry stays warm; we never
 * await the load, which would gain us nothing - the goal is to
 * populate the browser's bitmap cache, not to gate any UI work.
 */
export function preloadIcon(url: string): void {
  if (preloaded.has(url)) return;
  const img = new Image();
  // Decode off the main thread when supported; falls back to
  // synchronous decode otherwise.
  img.decoding = 'async';
  // `crossOrigin` is deliberately NOT set: we want this preload to
  // share its cache entry with the `<img>` elements in the apps
  // tab, which also don't set `crossOrigin`. Mismatched CORS
  // modes split the cache and defeat the purpose of preloading.
  img.src = url;
  preloaded.set(url, img);
}

/**
 * Batch prefetch for a list of apps. Called from `useApps()` as
 * soon as the catalog payload normalises so the bytes are warm by
 * the time the Apps tab paints.
 *
 * No-op for apps without a custom icon (null entries).
 */
export function prefetchAppIcons(urls: ReadonlyArray<string | null>): void {
  for (const url of urls) {
    if (typeof url === 'string' && url.length > 0) {
      preloadIcon(url);
    }
  }
}
