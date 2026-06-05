/**
 * Build-time environment variables exposed to the client bundle.
 *
 * Vite hands us anything prefixed with `VITE_` from `.env.local` /
 * `.env.development` / the CI environment via `import.meta.env`.
 * We funnel them through this single typed module so consumers
 * never touch `import.meta.env` directly - which keeps the env
 * surface discoverable (one grep on `ENV.` shows everything we
 * read at build time) and lets us compute defaults / coerce types
 * in one place.
 *
 * Add new env vars here. Document the contract (default, when to
 * override, who reads it) in the JSDoc, not in `.env.example`
 * alone, so the type-check + the grep both surface it.
 */

/**
 * Hugging Face central signaling Space used by the WebRTC SDK.
 *
 * Override at build time via `VITE_REACHY_CENTRAL_URL` (e.g. on a
 * staging environment). Defaults to the org-owned canonical Space;
 * the legacy `cduss-` and `tfrere-` instances stay running for
 * backward compatibility during the transition but should NOT be
 * the default for new installs.
 *
 * Consumers:
 *   - `features/auth/fetchRobotsFromCentral.ts` (HF central /api/robot-status)
 *   - `features/conversation/engine/conversation-engine.ts` (SDK signaling URL)
 */
export const CENTRAL_SIGNALING_URL: string =
  (import.meta.env.VITE_REACHY_CENTRAL_URL as string | undefined) ??
  'https://pollen-robotics-reachy-mini-central.hf.space';

/**
 * Hugging Face realtime backend selector.
 *
 * `deployed` uses the app-managed session allocator Space and is the
 * production default. `local` bypasses the allocator and connects to
 * `VITE_HF_REALTIME_WS_URL`, useful when running a local
 * speech-to-speech backend on a laptop or LAN host.
 *
 * Consumers:
 *   - `features/conversation/engine/huggingface-realtime.ts`
 */
export const HF_REALTIME_CONNECTION_MODE: 'deployed' | 'local' = (() => {
  const raw = (
    import.meta.env.VITE_HF_REALTIME_CONNECTION_MODE as string | undefined
  )
    ?.trim()
    .toLowerCase();
  if (raw === 'local' || raw === 'deployed') return raw;
  if (raw) {
    console.warn(
      `[env] invalid VITE_HF_REALTIME_CONNECTION_MODE=${JSON.stringify(
        raw,
      )}; using "deployed"`,
    );
  }
  return 'deployed';
})();

/**
 * App-managed HF session allocator.
 *
 * The allocator returns a short-lived `connect_url` for the current
 * deployed realtime backend. Keeping this behind a stable Space proxy
 * lets backend routing change without shipping a new mobile build.
 */
export const HF_REALTIME_SESSION_PROXY_URL: string =
  (import.meta.env.VITE_HF_REALTIME_SESSION_PROXY_URL as string | undefined) ??
  'https://pollen-robotics-reachy-mini-realtime-url.hf.space/session';

/**
 * Direct HF realtime websocket endpoint for local / LAN development.
 *
 * Accepts either a base URL such as `ws://127.0.0.1:8765/v1` or the
 * full websocket URL `ws://127.0.0.1:8765/v1/realtime`.
 */
export const HF_REALTIME_WS_URL: string | null = (() => {
  const raw = import.meta.env.VITE_HF_REALTIME_WS_URL as string | undefined;
  const trimmed = raw?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
})();

/**
 * Reachy Mini backend API host.
 *
 * Hosts every server-side endpoint the mobile shell consumes:
 *
 *   - `GET  /api/js-apps`          - curated app catalog (see
 *     `features/apps/useApps.ts`).
 *   - app/user metadata endpoints consumed by `features/apps/*`.
 *
 * This used to be the combined website Space
 * (`pollen-robotics-reachy-mini.hf.space`). The API has since been
 * split into its own dedicated Space; the showcase website is now a
 * separate static deploy. The env var keeps its historical name
 * (`VITE_REACHY_WEBSITE_URL`) for backward compatibility.
 *
 * Override at build time via `VITE_REACHY_WEBSITE_URL` (e.g. when
 * developing against a staging Space). Defaults to the production
 * pollen-robotics API Space.
 *
 * Consumers:
 *   - `features/apps/useApps.ts`
 */
export const WEBSITE_API_URL: string =
  (import.meta.env.VITE_REACHY_WEBSITE_URL as string | undefined) ??
  'https://pollen-robotics-reachy-mini-api.hf.space';

/**
 * Reachy Sticker Generator Space.
 *
 * FastAPI Space that turns a short visual theme into a transparent
 * Reachy sticker (PNG + vectorised SVG). Used by the personality
 * authoring flow to give custom personas a generated avatar.
 *
 * Endpoints (see `features/personalities/sticker-avatar.ts`):
 *   - `POST /api/generate` `{ prompt, kind }` -> `{ png_url, svg_url, ... }`
 *     (synchronous, ~1 min, 2 concurrent slots server-side).
 *   - `GET  /api/queue` -> `{ queue_size }` (waiting-position hint).
 *   - `GET  /api/community/<file>` -> the generated image bytes.
 *
 * Calls are routed through `@tauri-apps/plugin-http` (the Space serves
 * no `Access-Control-Allow-Origin`), so the host must also be allowed
 * in `src-tauri/capabilities/default.json`.
 *
 * Override at build time via `VITE_REACHY_STICKER_URL`.
 */
export const STICKER_API_URL: string =
  (import.meta.env.VITE_REACHY_STICKER_URL as string | undefined) ??
  'https://pollen-robotics-reachy-sticker-generator.hf.space';

/**
 * Dev-only Hugging Face token used to skip the OAuth sign-in screen
 * when running `tauri:dev` on a desktop WebView.
 *
 * The in-app `ASWebAuthenticationSession` flow only exists on iOS /
 * Android, so on a desktop dev build there is no way to actually sign
 * in. Setting `VITE_DEV_HF_TOKEN` in `.env.local` lets
 * `useRemoteHfToken` seed the token on first boot so the app drops you
 * straight onto the scan screen.
 *
 * Hard-gated behind `import.meta.env.DEV`: in any production build
 * (`vite build`) `DEV` is statically `false`, so this resolves to
 * `null` and gets tree-shaken away. The value can never ship in a
 * release bundle even if the env var is accidentally present in CI.
 *
 * Consumers:
 *   - `features/auth/useRemoteHfToken.ts` (boot-time seed fallback)
 */
export const DEV_HF_TOKEN: string | null = (() => {
  if (!import.meta.env.DEV) return null;
  const raw = import.meta.env.VITE_DEV_HF_TOKEN as string | undefined;
  const trimmed = raw?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
})();

/**
 * Optional display username paired with {@link DEV_HF_TOKEN}. Purely
 * cosmetic (the welcome-back banner / SDK `robot.username`); falls back
 * to a placeholder when omitted. Same dev-only gating as the token.
 */
export const DEV_HF_USERNAME: string | null = (() => {
  if (!import.meta.env.DEV) return null;
  const raw = import.meta.env.VITE_DEV_HF_USERNAME as string | undefined;
  const trimmed = raw?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
})();
