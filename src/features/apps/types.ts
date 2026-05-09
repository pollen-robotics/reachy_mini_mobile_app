/**
 * Catalog entry for a Reachy Mini app, after normalization from the
 * canonical website endpoint:
 *
 *   GET https://pollen-robotics-reachy-mini.hf.space/api/apps
 *
 * The endpoint returns a heterogeneous payload (some entries come
 * from HF Space metadata, some from a curated catalog). The shape
 * below is the *minimum* we rely on in the mobile app - additional
 * fields are kept on `extra` for future use without forcing another
 * normalization pass.
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
  /** Free-form tags (HF Space tags + cardData tags). */
  tags: string[];
  /** Engagement metrics from the HF Hub. Display-only. */
  likes: number;
  /** Original normalized payload, kept around for forward compatibility. */
  extra: Record<string, unknown>;
}
