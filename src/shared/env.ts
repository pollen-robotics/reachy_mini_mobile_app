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
 *   - `features/robot-session/engine/session-engine.ts` (SDK signaling URL)
 */
export const CENTRAL_SIGNALING_URL: string =
  (import.meta.env.VITE_REACHY_CENTRAL_URL as string | undefined) ??
  'https://pollen-robotics-reachy-mini-central.hf.space';

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
