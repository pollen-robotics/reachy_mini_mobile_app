/**
 * Fetch the HuggingFace OAuth token the daemon stored, so we can
 * forward it into sandboxed children that need to authenticate as
 * the user (notably the Apps tab's iframes).
 *
 * Why bridging is needed: the native ReachyMini SDK and any HF Space
 * embedded in our WebView both rely on `sessionStorage.hf_*` to skip
 * the OAuth redirect (which gets blocked by `X-Frame-Options:
 * SAMEORIGIN` on `huggingface.co/login`). The mobile-app gate already
 * seeds those keys from the user's own gate token (see
 * `useRemoteHfToken`), so the only remaining bridge that needs the
 * daemon-stored value is the Apps panel: it loads HF Spaces by URL
 * and the Space's iframe runs in a different storage origin.
 *
 * Security posture: the token lives on the daemon (issued by its own
 * OAuth flow), and the daemon's HTTP API is already unauthenticated on
 * the local network. Exposing the token back to the frontend here
 * doesn't widen the attack surface; we still keep it out of
 * `useHfAuth` so no component sees it unless it truly needs to seed a
 * sandboxed child context.
 */

import type { RobotClient } from '../robot-client/types';

interface HfTokenPayload {
  token: string;
}

/**
 * Token fetch routed through `RobotClient` so the call works on both
 * LAN HTTP and WebRTC `http_proxy` paths. Used by `AppsPanel` so the
 * Apps tab is no longer gated on the user being on the same Wi-Fi
 * as the robot.
 *
 * Returns `null` when the daemon has no token stored (treat as
 * "not signed in" - upstream auth flow handles that). Throws on
 * 5xx / network errors so callers can differentiate "definitely no
 * token" from "couldn't reach the daemon".
 */
export async function fetchHfTokenViaClient(
  client: RobotClient,
): Promise<string | null> {
  const response = await client.fetch<HfTokenPayload>('/api/hf-auth/token', {
    method: 'GET',
    timeoutMs: 4_000,
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Daemon /hf-auth/token replied ${response.status}`);
  }
  const token = response.data?.token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}
