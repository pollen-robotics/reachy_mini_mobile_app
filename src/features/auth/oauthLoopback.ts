/**
 * In-app OAuth sign-in against Hugging Face.
 *
 * High-level dance
 * ────────────────
 *   1. Generate PKCE pair (code_verifier + code_challenge SHA-256).
 *   2. Bind the Rust loopback bridge on `127.0.0.1:8000` (it waits
 *      for HF to call back and rewrites the response as a 302 to
 *      `reachymini://oauth/callback`).
 *   3. Open `ASWebAuthenticationSession` (iOS/macOS) or Chrome Custom
 *      Tabs (Android) pointing at HF's `/oauth/authorize`. The plugin
 *      keeps the user inside our app and listens for the
 *      `reachymini://` scheme.
 *   4. User signs in -> HF redirects to `http://localhost:8000/...`
 *      -> our loopback emits 302 to `reachymini://oauth/callback?...`
 *      -> the auth session intercepts the scheme and resolves with
 *      the full URL.
 *   5. Parse `code`+`state`, verify `state`, exchange the code for an
 *      access token via POST `/oauth/token` (PKCE, no client secret).
 *   6. Resolve the token (and the username we fetch from
 *      `/oauth/userinfo`) so `useRemoteHfToken` can persist it.
 *
 * Why an in-app session and not the system browser
 * ────────────────────────────────────────────────
 * Apple App Review (and increasingly Google) rejects flows that bounce
 * the user out to Safari for sign-in. `ASWebAuthenticationSession` is
 * the API Apple explicitly recommends: a system-managed sheet anchored
 * to the app's key window, sharing Safari cookies (so the user gets
 * SSO if they're already signed into HF in Safari) and the redirect
 * captured cryptographically via a custom URL scheme.
 *
 * Why a loopback bridge instead of a direct `reachymini://` redirect
 * ────────────────────────────────────────────────────────────────
 * HF's OAuth client `71146982-...` is registered with exactly one
 * redirect URI (`http://localhost:8000/api/hf-auth/oauth/callback`,
 * shared with the daemon's "lite" flow). Adding a second redirect URI
 * would need an HF-side config change. To avoid that, we keep the
 * registered URI as-is and let the Rust loopback rewrite it onto our
 * custom scheme. HF never sees the `reachymini://` URL.
 *
 * Why we don't re-use a Tauri webview for this
 * ────────────────────────────────────────────
 * `huggingface.co/login` ships `X-Frame-Options: SAMEORIGIN` which
 * blocks any iframe / WebView embed. ASWebAuthenticationSession
 * sidesteps that because it's a top-level webview, not an iframe.
 */
import { invoke } from '@tauri-apps/api/core';
import { start as startAuthSession } from 'tauri-plugin-auth-session-api';

const HF_OAUTH_CLIENT_ID = '71146982-8184-45a2-b05a-d561b3cd701d';
const HF_OAUTH_REDIRECT_URI = 'http://localhost:8000/api/hf-auth/oauth/callback';
const HF_OAUTH_AUTHORIZE_URL = 'https://huggingface.co/oauth/authorize';
const HF_OAUTH_TOKEN_URL = 'https://huggingface.co/oauth/token';

/**
 * Custom URL scheme `ASWebAuthenticationSession` (and the matching
 * Chrome Custom Tabs intent filter on Android) intercepts. Mirrors the
 * `SCHEME_REDIRECT_PREFIX` constant in `src-tauri/src/oauth.rs`. If you
 * change one, change the other and update the Android intent filter in
 * `AndroidManifest.xml`.
 */
const CALLBACK_URL_SCHEME = 'reachymini';

// Mirrors the daemon's default scopes (see hf_auth.py). Kept in sync
// so the token we get is interchangeable with one obtained on LAN.
const HF_OAUTH_SCOPES =
  'openid profile read-repos write-repos manage-repos inference-api';

interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * Run the full sign-in dance and return the freshly minted access
 * token plus the username we get back from `/oauth/userinfo`. The
 * caller is expected to persist both via `useRemoteHfToken.setToken`.
 */
export async function loginWithHuggingFace(): Promise<{
  token: string;
  username: string | null;
}> {
  const pkce = await generatePkcePair();
  const state = randomUrlSafe(32);

  // Bind 127.0.0.1:8000 BEFORE opening the session so the redirect
  // can't race the bind. Bridge cleans up after one callback or on
  // FLOW_TIMEOUT, but we also cancel explicitly in `finally` below
  // in case the user dismisses the session before HF ever redirects.
  await invoke('start_oauth_bridge');

  try {
    const authorizeUrl = buildAuthorizeUrl({
      state,
      codeChallenge: pkce.challenge,
    });

    // The plugin throws a *string* (not an Error) per its docs:
    //   - "user_cancelled" when the user dismisses the sheet
    //   - "Auth session error: ..." for platform-level failures
    //   - "In-app auth sessions are only available on Apple and Android
    //     platforms" on Linux/Windows
    // We re-throw as Error so `friendlyAuthError` can pattern-match.
    let callbackUrl: string;
    try {
      callbackUrl = await startAuthSession(authorizeUrl, CALLBACK_URL_SCHEME);
    } catch (raw) {
      // Android rescue: the browser blocked the scheme launch and the
      // user closed the tab; the bridge kept HF's callback (see oauth.rs).
      const rescued = await invoke<string | null>('take_oauth_callback').catch(() => null);
      if (rescued) {
        callbackUrl = rescued;
      } else {
        throw mapAuthSessionError(raw);
      }
    }

    const url = new URL(callbackUrl);
    const callbackError = url.searchParams.get('error');
    if (callbackError) {
      const description = url.searchParams.get('error_description') ?? '';
      throw new Error(
        `Provider error: HF returned ${callbackError}${
          description ? ` (${description})` : ''
        }`,
      );
    }

    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    if (!code) {
      throw new Error('OAuth callback missing `code` parameter');
    }
    if (returnedState !== state) {
      throw new Error(
        `StateMismatch: expected ${state}, got ${returnedState ?? 'null'}`,
      );
    }

    const tokenPayload = await exchangeCodeForToken({
      code,
      codeVerifier: pkce.verifier,
    });

    const username = await fetchUsername(tokenPayload.access_token);
    return { token: tokenPayload.access_token, username };
  } finally {
    // Always release the loopback. If `startAuthSession` resolved, the
    // bridge already exited after sending its 302 (no-op). If the user
    // cancelled or an error fired before HF hit the loopback, this
    // releases port 8000 immediately so a retry can rebind without
    // waiting for FLOW_TIMEOUT.
    try {
      await invoke('cancel_oauth_bridge');
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Aborts an in-flight bridge listener. Safe to call when no flow is
 * running (no-op on the Rust side). Wired to the "Back" / "Cancel"
 * button on the sign-in screen.
 */
export async function cancelLoginFlow(): Promise<void> {
  try {
    await invoke('cancel_oauth_bridge');
  } catch {
    // Cancellation is a best-effort hint, never a hard failure.
  }
}

/* --- internals -------------------------------------------------------- */

function buildAuthorizeUrl(opts: {
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: HF_OAUTH_CLIENT_ID,
    // Stay on the HF-registered redirect URI: HF only knows about the
    // loopback URL, the `reachymini://` scheme is invented locally by
    // our bridge (see `src-tauri/src/oauth.rs`).
    redirect_uri: HF_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: HF_OAUTH_SCOPES,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${HF_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

async function exchangeCodeForToken(opts: {
  code: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  // Public PKCE client: send `client_id` in the body, no secret.
  // Content-Type must be x-www-form-urlencoded per RFC 6749. The
  // `redirect_uri` MUST match the value we sent in `/authorize` (the
  // loopback URL, not the custom scheme).
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: HF_OAUTH_REDIRECT_URI,
    client_id: HF_OAUTH_CLIENT_ID,
    code_verifier: opts.codeVerifier,
  });
  const resp = await fetch(HF_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HF token exchange failed (${resp.status}): ${text}`);
  }
  const data = (await resp.json()) as TokenResponse;
  if (!data.access_token) {
    throw new Error('HF token exchange returned no access_token');
  }
  return data;
}

async function fetchUsername(token: string): Promise<string | null> {
  // `/oauth/userinfo` is the standard OIDC endpoint and is what HF
  // recommends for bearer-introspection. We could call `/api/whoami`
  // too but userinfo is reachable with an `openid profile` scope and
  // returns a stable `name` field.
  try {
    const resp = await fetch('https://huggingface.co/oauth/userinfo', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      name?: string;
      preferred_username?: string;
    };
    return data.preferred_username ?? data.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Convert the plugin's string-style errors into `Error` instances whose
 * `message` plays nicely with `friendlyAuthError` on the UI side. We
 * keep the existing token vocabulary (Cancelled / Bind / Timeout / ...)
 * so the same regex mapper used by the old loopback flow still works.
 */
function mapAuthSessionError(raw: unknown): Error {
  const message = typeof raw === 'string' ? raw : String(raw);
  if (message === 'user_cancelled') {
    return new Error('Cancelled: user dismissed the sign-in sheet');
  }
  if (message.includes('only available on Apple and Android')) {
    return new Error(
      'In-app sign-in is not supported on this platform; build for iOS or Android to test.',
    );
  }
  if (message.startsWith('Auth session error:')) {
    return new Error(`Provider error: ${message}`);
  }
  return new Error(message);
}

/* --- PKCE primitives -------------------------------------------------- */

async function generatePkcePair(): Promise<PkcePair> {
  // RFC 7636: verifier is 43-128 chars from the unreserved alphabet.
  const verifier = randomUrlSafe(64);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

function randomUrlSafe(byteLen: number): string {
  // Generate `byteLen` random bytes and base64url-encode them. The
  // result keeps the unreserved-character invariant the spec wants.
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  // btoa works on binary strings, not on byte arrays directly.
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
