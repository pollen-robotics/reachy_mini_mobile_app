/**
 * Build the iframe URL for an embedded Reachy Mini app.
 *
 * Subdomain rules (HF docs + observed via `/api/spaces/<id>.host`):
 *
 *   sdk=static          → https://<slug>.static.hf.space/
 *   sdk=docker|gradio|… → https://<slug>.hf.space/
 *
 * Where `<slug>` is the repo id lowercased with `_` and `/` replaced
 * by `-`. Examples:
 *
 *   Anne-Charlotte/music-quiz  (sdk=static)  → https://anne-charlotte-music-quiz.static.hf.space/
 *   tfrere/reachy-mini-app     (sdk=docker)  → https://tfrere-reachy-mini-app.hf.space/
 *
 * The `static` fork matters: pre-2025-Q1 we hit the bare `*.hf.space`
 * subdomain for every Space and got a 404 on every static one, which
 * silently broke ~80% of the `reachy_mini_js_app` catalogue.
 *
 * Query params:
 *
 *   embedded=1            - signals a host frame is hosting the app
 *   theme=dark|light      - palette
 *   robot_peer_id=<id>    - target robot for the SDK to startSession on
 *   robot_name=<name>     - display only, the app may show it in chrome
 *   _t=<ts>               - cache-bust (apps reuse the same Space port)
 *
 * URL fragment (intentionally separate from the query string):
 *
 *   hf_token=<jwt>        - parent's HF access token, picked up by
 *                           the app via `consumeTokenFromHash()`
 *                           (or equivalent) BEFORE `robot.authenticate()`
 *                           runs, so the app can skip OAuth.
 *
 * Why a fragment and not a query param: fragments are NOT sent on
 * HTTP requests (no referrer, no server logs), they only live
 * client-side. That's the same protection the vibe-coder preview
 * iframe gets from injecting the token via `<script>` (its srcDoc
 * pattern), but cross-origin friendly. The `AppIframeOverlay` ALSO
 * sends the token via `postMessage` after `onLoad` as a fallback
 * for apps that prefer that pattern; both paths set
 * `sessionStorage.hf_token` (or `window.__REACHY_MINI_PREVIEW_TOKEN__`
 * for the vibe-coder convention).
 *
 * The fragment-based handover only works when the embedded app
 * runs `consumeTokenFromHash()` (or similar) at module load time,
 * BEFORE its first `robot.authenticate()` call. The
 * `reachy_mini_minimal_conversation` app already does this; new
 * apps generated via the vibe-coder skill should adopt the same
 * boilerplate (see SKILL.md update note in the mobile repo).
 */
import type { AppSdk } from './types';

export interface AppEmbedContext {
  /** HF access token. Goes into the URL fragment, NOT the query
   * string (see file-level comment for the rationale). */
  hfToken: string;
  /** HF username. The bundled ReachyMini SDK's `authenticate()`
   * reads `sessionStorage.hf_username` alongside the token; without
   * it, the cache check fails even when the token is present, and
   * the app falls through to a full OAuth round-trip (which can't
   * complete inside an iframe). */
  hfUsername: string | null;
  robotPeerId: string;
  robotName: string;
  theme: 'dark' | 'light';
}

export function spaceIdToSlug(spaceId: string): string {
  return spaceId.toLowerCase().replace(/_/g, '-').replace(/\//g, '-');
}

/**
 * Pick the runtime subdomain for the given SDK. Centralised in one
 * helper so the rule is documented once and the call sites stay
 * declarative ({@link buildAppEmbedUrl} is the only one today, but
 * a future debug tool that lists the runtime URL alongside the card
 * URL will reuse this).
 */
export function spaceRuntimeHost(slug: string, sdk: AppSdk): string {
  return sdk === 'static'
    ? `https://${slug}.static.hf.space`
    : `https://${slug}.hf.space`;
}

export function buildAppEmbedUrl(
  spaceId: string,
  sdk: AppSdk,
  ctx: AppEmbedContext,
): string {
  const slug = spaceIdToSlug(spaceId);
  const url = new URL(`${spaceRuntimeHost(slug, sdk)}/`);
  url.searchParams.set('embedded', '1');
  url.searchParams.set('theme', ctx.theme);
  url.searchParams.set('robot_peer_id', ctx.robotPeerId);
  url.searchParams.set('robot_name', ctx.robotName);
  url.searchParams.set('_t', String(Date.now()));
  // HF access token, username and a far-future expiry ride in the
  // URL FRAGMENT, not the query string. Fragments don't travel on
  // HTTP (no referrer, no server logs), so the only place the
  // token is observable is the iframe's own `window.location.hash`.
  //
  // We send THREE keys because the bundled ReachyMini SDK's
  // `authenticate()` requires `hf_token` + `hf_username` +
  // `hf_token_expires` in `sessionStorage` and rejects the cache
  // hit if any are missing. Sending only the token would let
  // `consumeTokenFromHash()` populate `hf_token` but leave the SDK
  // falling back to OAuth (which can't complete in an iframe -
  // HF's login page ships `X-Frame-Options: SAMEORIGIN`).
  //
  // The expiry is synthesised a year out: HF personal access tokens
  // don't carry a real expiration, the daemon-mediated OAuth tokens
  // are also long-lived, and the value is only ever consulted for
  // "is this still valid?" gating - the actual server-side
  // validation happens on the next authenticated call.
  const expiresIso = new Date(
    Date.now() + 365 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const fragment = new URLSearchParams();
  fragment.set('hf_token', ctx.hfToken);
  fragment.set('hf_username', ctx.hfUsername ?? 'user');
  fragment.set('hf_token_expires', expiresIso);
  url.hash = fragment.toString();
  return url.toString();
}
