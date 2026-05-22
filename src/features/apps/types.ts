/**
 * Catalog entry for a Reachy Mini app, after normalization from the
 * canonical website endpoint:
 *
 *   GET https://pollen-robotics-reachy-mini.hf.space/api/js-apps
 *
 * The endpoint returns JS apps already pre-filtered server-side (no
 * more client-side `reachy_mini_js_app` tag filter) and attaches a
 * `categories` array per app, classified by an LLM running on the
 * website Space. The shape below is the *minimum* we rely on in the
 * mobile app - additional fields are kept on `extra` for future use
 * without forcing another normalization pass.
 *
 * Cross-reference: the desktop app uses a much richer normalization
 * step that includes installed-on-daemon merging. Mobile doesn't
 * install apps; it only ever shows them as iframes pointing at the
 * canonical HF Space runtime URL. So we deliberately keep the
 * surface tiny here.
 */
/**
 * The Space's HF SDK. Drives which subdomain pattern carries the
 * runtime:
 *   - `static`           → `<slug>.static.hf.space`
 *   - `docker` / `gradio` / `streamlit` / unknown → `<slug>.hf.space`
 *
 * We pick `static` vs everything-else because that's the only fork
 * in the runtime URL; the engine doesn't actually care WHICH
 * non-static SDK is in use.
 */
export type AppSdk = 'static' | 'other';

export interface AppEntry {
  /** Stable id, typically `<author>/<repo>`. Used for routing + deduplication. */
  id: string;
  /** Display name from the catalog. */
  name: string;
  /** One-line description, may be empty. */
  description: string;
  /** HF Space card URL (`https://huggingface.co/spaces/<author>/<repo>`). NOT the iframe target. */
  spaceUrl: string;
  /** Author / namespace (org or user). */
  author: string | null;
  /** Whether the catalog entry is from `pollen-robotics`. */
  isOfficial: boolean;
  /**
   * Coarse SDK classification used to pick the runtime subdomain in
   * `buildAppEmbedUrl()`. `static` Spaces ship under `*.static.hf.space`,
   * everything else under `*.hf.space`. Unknown / missing values fall
   * back to `other`, so the URL points at the standard subdomain (and
   * the iframe will simply 404 instead of misroute - which we already
   * surface to the user via the load-timeout overlay).
   */
  sdk: AppSdk;
  /**
   * Author-chosen emoji for the Space (set in the README front-matter
   * via `emoji: 🎵`). Sourced from `extra.cardData.emoji` in the
   * catalog payload. Used as the avatar glyph in the apps list when
   * present; consumers fall back to a generic icon when `null`.
   */
  emoji: string | null;
  /**
   * Absolute HF `resolve/main/` URL for a custom app icon, resolved
   * server-side from the Space's `siblings` list (see catalog's
   * `findIconUrl()`). Set when the author committed `icon.svg`
   * (preferred) or `icon.png` at the repo root; `null` otherwise.
   *
   * When present, renderers MUST prefer this over `emoji` so app
   * authors can ship a polished avatar without changing the
   * mobile/desktop codebases. SVG → vector-clean at every size.
   *
   * Resolution lives on the server (`reachy-mini-website`) so we
   * detect once per catalog refresh (5-min cache) for the whole
   * fleet of clients, instead of every mobile shell hitting the
   * Hub to probe two filenames per app on cold start.
   */
  iconUrl: string | null;
  /** Free-form tags (HF Space tags + cardData tags). */
  tags: string[];
  /** Engagement metrics from the HF Hub. Display-only. */
  likes: number;
  /**
   * Server-published taxonomy ids classifying this app
   * (e.g. `['voice', 'dance']`). Multi-valued. The set of valid
   * ids is the closed taxonomy mirrored in `categoryTaxonomy.ts`.
   *
   * `null` or `[]` means "not classified yet": the app does not
   * surface in any thematic rail but still appears in the "ALL APPS"
   * trailing list and in search results.
   *
   * Source of truth lives on the website server
   * (`reachy-mini-website/server/categories.js`); the mobile client
   * never infers categories.
   */
  categories: string[] | null;
  /**
   * How the categories were produced. `"inferred"` today (LLM on the
   * website Space). The server may later add `"curated"` for
   * hand-edited overrides. V1 mobile ignores this; we keep the field
   * typed so a future "curated" badge is one prop away.
   */
  categoriesSource: string | null;
  /**
   * ISO 8601 timestamp from when the server classified this app.
   * Display-only. V1 mobile ignores it but keeps the field for a
   * future "Recently classified" affordance.
   */
  categorizedAt: string | null;
  /** Original normalized payload, kept around for forward compatibility. */
  extra: Record<string, unknown>;
}

/**
 * One entry of the server-published category taxonomy. Mirrors
 * the shape returned by `getPublicTaxonomy()` in
 * `reachy-mini-website/server/categories.js`. We deliberately
 * keep the shape minimal: `slug` and `label` are required for UI
 * rendering, `emoji` and `order` are nice-to-haves the server
 * always ships today but the client tolerates missing.
 */
export interface ApiCategoryEntry {
  slug: string;
  label: string;
  emoji: string | null;
  order: number | null;
}

/**
 * Top-level meta block published by `/api/js-apps` describing the
 * server's classification state. Surfaced by `useApps()` so a
 * future UI can hint "Classifying new apps..." when
 * `inProgress === true`.
 *
 * `taxonomy` is the authoritative slug list for this catalog
 * snapshot. Consumers should pass it through
 * `resolveTaxonomy()` in `categoryTaxonomy.ts` to obtain the
 * render-ready `CategoryDescriptor[]`. The field is `null` when
 * talking to a pre-taxonomy-shipping server build (forward
 * compatibility): the resolver falls back to the local snapshot.
 */
export interface CategorizationMeta {
  enabled: boolean;
  total: number;
  classified: number;
  pending: number;
  inProgress: boolean;
  /** HF Hub dataset id where the LLM cache lives (e.g. `tfrere/reachy-mini-app-categories`). */
  dataset: string | null;
  /** Server-side taxonomy version. Increments when categories ids change. */
  taxonomyVersion: number | null;
  /**
   * Live taxonomy projection (slug + label + emoji + order). `null`
   * when the server hasn't shipped this field yet - callers fall
   * back to the local snapshot in `categoryTaxonomy.ts`.
   */
  taxonomy: readonly ApiCategoryEntry[] | null;
}
