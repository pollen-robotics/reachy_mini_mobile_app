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
 * Protocol v1
 * ───────────
 * Mobile is the host. It builds a URL the app's `index.html`
 * dispatcher recognises as "I am embedded" - that's the single
 * `?embedded=1` query param the dispatcher in every Reachy Mini app
 * branches on:
 *
 *   /index.html?embedded=1#creds=<base64(JSON CredsBundle)>
 *
 * The `creds` hash carries everything the app needs to boot a
 * session synchronously (token, username, robot peer id,
 * signaling URL, theme, opaque config). Format identical to the
 * `encodeCredsToHash()` helper exported by `@reachy-mini/host`,
 * so the app's iframe code (the embed entry from
 * `@reachy-mini/host/embed`) decodes it natively.
 *
 * Query params kept for back-compat / cache busting:
 *
 *   embedded=1            - flips the dispatcher into embed mode
 *   theme=dark|light      - drives `<html data-theme>` in the
 *                           inline boot script BEFORE the JS
 *                           bundle loads (avoids a palette flash)
 *   _t=<ts>               - cache-bust (apps reuse the same Space port)
 *
 * Why a fragment (not a query param) for the creds: fragments are
 * NOT sent on HTTP requests (no referrer, no server logs), they
 * only live client-side. Same protection the legacy
 * `#hf_token=` handover already enjoyed - we just unified the
 * payload shape behind a single base64 envelope so the app side
 * can decode in one call.
 *
 * postMessage bridge
 * ──────────────────
 * After the iframe loads, the embed posts `embed:ready` to the
 * parent (this app). The mobile shell replies with `host:init` at
 * the protocol-v1 wire format (`source: 'reachy-mini'`, `type:
 * 'host:init'`, `version: 1`) so the embed can resolve its boot
 * synchronously instead of waiting on its fallback timer. The
 * payload is the same data we already serialised into the hash -
 * built once via `buildEmbedCreds()` and reused for both channels
 * so they can never drift.
 *
 * If the parent never sends `host:init` (older mobile builds,
 * manual testing, scripted page hits), the embed waits a short
 * `HOST_INIT_TIMEOUT_MS` and proceeds from the hash creds alone -
 * graceful degradation, no hard dependency on the postMessage
 * channel.
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
  /**
   * Stable hardware id of the robot (central `meta.hardware_id`), or
   * `null` for a daemon too old to expose one. Threaded through so the
   * embed can re-resolve the live `robotPeerId` from central right
   * before `startSession()` - the bare peer id rotates on every relay
   * reconnect and is frequently dead after a Space cold-start.
   */
  robotHardwareId?: string | null;
  robotName: string;
  theme: 'dark' | 'light';
  /**
   * Pollen central signaling URL. Forwarded so the SDK constructor
   * inside the iframe lands on the same central we're already
   * connected to (production / staging / self-hosted), without
   * the app having to bake the URL itself.
   */
  signalingUrl?: string;
  /**
   * App-specific configuration blob. Opaque to mobile (and to the
   * Reachy Mini host package) - we just base64-encode it through
   * to the embed. Apps validate the shape on their side.
   *
   * Example: for the emotions app, you'd pass
   * `{ emotion: 'joy', autoPlay: true }` so a deep-link from
   * the mobile UI ("play joy on this robot") boots straight
   * into the right wedge.
   */
  config?: unknown;
  /**
   * App display name to thread through `host:init`. The embed
   * surfaces this to its UI (e.g. window title); falls back to
   * the iframe's `<title>` if missing.
   */
  appName?: string;
  /**
   * Host display name to thread through `host:init` (e.g.
   * "Reachy Mini" or "Reachy Mini (mobile)"). Optional - the
   * embed only uses this as a credit line.
   */
  hostName?: string;
}

export function spaceIdToSlug(spaceId: string): string {
  return spaceId.toLowerCase().replace(/_/g, '-').replace(/\//g, '-');
}

/**
 * Pick the runtime subdomain for the given SDK. Centralised in one
 * helper so the rule is documented once and the call sites stay
 * declarative.
 */
export function spaceRuntimeHost(slug: string, sdk: AppSdk): string {
  return sdk === 'static'
    ? `https://${slug}.static.hf.space`
    : `https://${slug}.hf.space`;
}

/**
 * Encode the credentials bundle into a URL-safe base64 string,
 * matching the format `@reachy-mini/host` expects in
 * `decodeCredsFromHash()`. Accepts the typed `EmbedCredsBundle`
 * directly (declared below) so callers don't have to cast through
 * `Record<string, unknown>`.
 */
function encodeCreds(bundle: EmbedCredsBundle): string {
  const json = JSON.stringify(bundle);
  return btoa(unescape(encodeURIComponent(json)));
}

const DEFAULT_SIGNALING_URL =
  'https://pollen-robotics-reachy-mini-central.hf.space';

/**
 * Protocol v1 credentials bundle. Same shape as
 * `@reachy-mini/host/lib/protocol#CredsBundle` (camelCase keys, no
 * `username` typo - the embed's `seedSessionToken` gates on
 * `userName` and a snake/lower typo silently drops the HF token).
 *
 * We don't import the type from `@reachy-mini/host` because the
 * mobile shell doesn't depend on that package; duplicating ~10
 * lines is cheaper than dragging the React build pipeline of the
 * host package into a Tauri bundle.
 */
export interface EmbedCredsBundle {
  hfToken: string;
  userName: string;
  robotPeerId: string;
  /** Stable hardware id (central `meta.hardware_id`) so the embed can
   *  re-resolve the live peer id before dialing. `null` when unknown. */
  robotHardwareId: string | null;
  signalingUrl: string;
  theme: 'dark' | 'light';
  config: unknown;
  hostName: string;
  appName: string;
}

/**
 * Build the protocol v1 creds bundle for an embedded app. Used in
 * two places that MUST stay byte-identical:
 *
 *   1. Encoded into the URL hash (`#creds=<base64>`) so the embed
 *      can decode it on its first synchronous tick, before any
 *      `await`.
 *   2. Posted as `host:init` over postMessage once the iframe
 *      shouts `embed:ready` so the embed resolves its
 *      `awaitHostInit` immediately instead of falling back through
 *      its timeout.
 *
 * Centralising the construction here means the two channels are
 * literally the same object: theme, signaling URL, opaque config
 * etc. cannot drift between hash and postMessage, and there is no
 * second source of truth to keep in sync.
 */
export function buildEmbedCreds(
  ctx: AppEmbedContext,
  appNameFallback?: string,
): EmbedCredsBundle {
  return {
    hfToken: ctx.hfToken,
    userName: ctx.hfUsername ?? 'user',
    robotPeerId: ctx.robotPeerId,
    robotHardwareId: ctx.robotHardwareId ?? null,
    signalingUrl: ctx.signalingUrl ?? DEFAULT_SIGNALING_URL,
    theme: ctx.theme,
    config: ctx.config ?? null,
    hostName: ctx.hostName ?? 'Reachy Mini',
    appName: ctx.appName ?? appNameFallback ?? ctx.robotName,
  };
}

export function buildAppEmbedUrl(
  spaceId: string,
  sdk: AppSdk,
  ctx: AppEmbedContext,
): string {
  const slug = spaceIdToSlug(spaceId);
  const url = new URL(`${spaceRuntimeHost(slug, sdk)}/`);
  // Single query flag the dispatcher branches on. Kept as the
  // legacy `?embedded=1` (rather than `?embed=1`) so older Spaces
  // that haven't been redeployed against the new host bundle keep
  // booting directly into their embed entry - no shell on top.
  url.searchParams.set('embedded', '1');
  url.searchParams.set('theme', ctx.theme);
  url.searchParams.set('_t', String(Date.now()));

  const bundle = buildEmbedCreds(ctx);
  url.hash = `creds=${encodeURIComponent(encodeCreds(bundle))}`;
  return url.toString();
}
