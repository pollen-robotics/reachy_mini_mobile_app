/**
 * Fetch the stored HuggingFace OAuth session from the daemon so we can
 * bridge it into the embedded conversation engine / sandboxed iframes.
 *
 * Why bridging is needed: the native ReachyMini SDK and any HF Space
 * embedded in our WebView both rely on `sessionStorage.hf_*` to skip
 * the OAuth redirect (which gets blocked by `X-Frame-Options:
 * SAMEORIGIN` on `huggingface.co/login`). We pull the token from the
 * daemon, which got it legitimately via its own OAuth flow earlier,
 * and seed it client-side.
 *
 * Why we need more than the token: the SDK's `authenticate()` ignores
 * any partial session. It requires the triple:
 *   - `hf_token`
 *   - `hf_username`
 *   - `hf_token_expires`  (parsable by `new Date()`, and in the future)
 * Missing any of the three makes it return `false`, sending the UI to
 * "signed-out" even when the token itself is valid.
 *
 * So this module does two things atomically:
 *   1. GET /api/hf-auth/token   → raw token
 *   2. GET /api/hf-auth/status  → { username, is_logged_in }
 * plus a local JWT decode to extract `exp` → ISO date.
 *
 * Security posture: the token lives on the daemon (issued by its own
 * OAuth flow), and the daemon's HTTP API is already unauthenticated on
 * the local network. Exposing the token back to the frontend here
 * doesn't widen the attack surface; we still keep it out of
 * `useHfAuth` so no component sees it unless it truly needs to seed a
 * sandboxed child context.
 */

import { daemonFetch } from '../daemon/daemonFetch';
import { decodeHfTokenExpiry, type HfSessionSeed } from '../conversation/useReachySdk';

interface HfTokenPayload {
  token: string;
}

interface HfStatusPayload {
  is_logged_in: boolean;
  username?: string | null;
}

/**
 * Raw token fetch. Left exported for callers that genuinely only need
 * the token (e.g. URL-hash bridging into a Space iframe that does its
 * own `authenticate()` flow).
 */
export async function fetchHfToken(host: string): Promise<string | null> {
  const response = await daemonFetch<HfTokenPayload>(host, '/api/hf-auth/token', {
    timeoutMs: 4_000,
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Daemon /hf-auth/token replied ${response.status}`);
  }
  const token = response.data?.token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Full session fetch. Returns everything the ReachyMini SDK needs to
 * skip its OAuth redirect. Returns `null` if the daemon has no token
 * (treat as "not signed in"). Throws on network / 5xx so callers can
 * differentiate "definitely signed out" from "daemon unreachable".
 */
export async function fetchHfSession(host: string): Promise<HfSessionSeed | null> {
  // Fire both requests in parallel — they're independent and the
  // daemon is on the same LAN, so serialising them would just double
  // the cold-start latency of ConversePanel.
  const [tokenRes, statusRes] = await Promise.all([
    daemonFetch<HfTokenPayload>(host, '/api/hf-auth/token', { timeoutMs: 4_000 }),
    daemonFetch<HfStatusPayload>(host, '/api/hf-auth/status', { timeoutMs: 4_000 }),
  ]);

  if (tokenRes.status === 404) return null;
  if (!tokenRes.ok) {
    throw new Error(`Daemon /hf-auth/token replied ${tokenRes.status}`);
  }
  if (!statusRes.ok) {
    throw new Error(`Daemon /hf-auth/status replied ${statusRes.status}`);
  }

  const token = tokenRes.data?.token;
  if (typeof token !== 'string' || token.length === 0) return null;

  const username = statusRes.data?.username;
  if (typeof username !== 'string' || username.length === 0) {
    // Daemon has a token but no username - treat as inconsistent and
    // fail the bridge rather than seeding a half-session the SDK would
    // reject with a hard-to-debug "signed-out" state.
    throw new Error('Daemon reports a token without a username');
  }

  const expiresAt = decodeHfTokenExpiry(token);
  if (!expiresAt) {
    throw new Error('Could not decode HF token expiry claim');
  }
  if (expiresAt.getTime() <= Date.now()) {
    // Surface expiry to the caller instead of seeding a dead session
    // the SDK would silently reject.
    throw new Error('HF token on daemon has expired');
  }

  return {
    token,
    username,
    expiresAt: expiresAt.toISOString(),
  };
}
