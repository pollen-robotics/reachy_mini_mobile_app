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
