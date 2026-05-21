/**
 * URL helpers for the Hugging Face Space card / report flow.
 *
 * Why these are separate from `buildEmbedUrl.ts`:
 *
 * - `buildEmbedUrl.ts` produces the **runtime** URL of a Space, i.e.
 *   the iframe src that hosts the actual app (`*.hf.space` or
 *   `*.static.hf.space`). That's where the app *runs*.
 * - This file produces the **catalog page** URL, i.e. the
 *   `huggingface.co/spaces/<owner>/<slug>` page where HF surfaces the
 *   author, the README, the community discussions, and - critically
 *   for our App Store / Play Store UGC compliance - the **"Report
 *   this Space"** affordance.
 *
 * Apple guideline 1.2 ("User Generated Content") requires the host
 * app to expose a way to report objectionable third-party content
 * from any surface where it's consumed. We delegate the actual
 * report flow to HF Trust & Safety (the platform of origin of the
 * content) by deeplinking to the Space page with the `?report=true`
 * query parameter, which makes HF auto-open its built-in report
 * modal on page load. From the user's perspective: tap "Report" in
 * our shell -> HF report dialog opens immediately in the system
 * browser. From Apple's perspective: there's a clearly-labelled
 * affordance on every UGC surface, and it leads to a real reporting
 * pipeline. See `docs/APP_STORE_COMPLIANCE.md` for the full
 * rationale.
 *
 * The functions take an `AppEntry` rather than raw `(author, slug)`
 * because the catalog already gives us the canonical
 * `https://huggingface.co/spaces/<author>/<slug>` URL in
 * `AppEntry.spaceUrl`. We just append the query param and avoid the
 * risk of mis-reconstructing the host (HF accepts both `huggingface.co`
 * and `hf.co` redirects but the report parameter is documented on
 * the canonical host).
 */
import type { AppEntry } from './types';

/**
 * URL of the Space's HF Hub card page (author, README, community
 * tab). Used for the "View on Hugging Face" menu item. This is just
 * `app.spaceUrl` today; we wrap it in a helper so a future
 * normalisation (e.g. forcing `huggingface.co` over `hf.co`) lives
 * in one place rather than being duplicated at each call site.
 */
export function buildSpaceCardUrl(app: AppEntry): string {
  return app.spaceUrl;
}

/**
 * URL of the Space's HF Hub card page with the report dialog
 * pre-opened. Tapping this opens the system browser on the Space
 * page; HF reads the `?report=true` query param and surfaces its
 * report modal as soon as the page lands. The user picks a category
 * from HF's standard list (spam, abusive, copyright, etc.), HF
 * Trust & Safety handles the rest.
 *
 * If `app.spaceUrl` already carries query params (which the catalog
 * never does today, but defensively), we append with `&` instead of
 * `?` so we don't break the URL.
 */
export function buildSpaceReportUrl(app: AppEntry): string {
  const sep = app.spaceUrl.includes('?') ? '&' : '?';
  return `${app.spaceUrl}${sep}report=true`;
}
