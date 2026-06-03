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
 * Reachy Mini backend API host.
 *
 * Hosts every server-side endpoint the mobile shell consumes:
 *
 *   - `GET  /api/js-apps`          - curated app catalog (see
 *     `features/apps/useApps.ts`).
 *   - `POST /api/openai/ephemeral` - mints per-user OpenAI Realtime
 *     ephemeral session keys (replaces the deprecated build-time
 *     `VITE_OPENAI_API_KEY` injection). See
 *     `features/conversation/engine/ephemeral-key.ts`.
 *
 * This used to be the combined website Space
 * (`pollen-robotics-reachy-mini.hf.space`). The API has since been
 * split into its own dedicated Space; the showcase website is now a
 * separate static deploy. The env var keeps its historical name
 * (`VITE_REACHY_WEBSITE_URL`) for backward compatibility.
 *
 * Override at build time via `VITE_REACHY_WEBSITE_URL` (e.g. when
 * developing against a staging Space). Defaults to the production
 * pollen-robotics API Space; the mint endpoint requires the master
 * `OPENAI_API_KEY` in that Space's secrets to actually return a key.
 *
 * Consumers:
 *   - `features/apps/useApps.ts`
 *   - `features/conversation/engine/ephemeral-key.ts`
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
