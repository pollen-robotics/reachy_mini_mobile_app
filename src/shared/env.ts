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
