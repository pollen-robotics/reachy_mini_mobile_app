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
 * Reachy Mini website API host.
 *
 * Hosts the server-side endpoints the mobile shell consumes without
 * a robot in the loop. Today:
 *
 *   - `POST /api/openai/ephemeral` - mints per-user OpenAI Realtime
 *     ephemeral session keys (replaces the deprecated build-time
 *     `VITE_OPENAI_API_KEY` injection). See
 *     `features/conversation/engine/ephemeral-key.ts`.
 *
 * Override at build time via `VITE_REACHY_WEBSITE_URL` (e.g. when
 * developing against a staging Space). Defaults to the production
 * pollen-robotics Space; the mint endpoint requires the master
 * `OPENAI_API_KEY` in that Space's secrets to actually return a key.
 *
 * Consumers:
 *   - `features/conversation/engine/ephemeral-key.ts`
 */
export const WEBSITE_API_URL: string =
  (import.meta.env.VITE_REACHY_WEBSITE_URL as string | undefined) ??
  'https://pollen-robotics-reachy-mini.hf.space';
