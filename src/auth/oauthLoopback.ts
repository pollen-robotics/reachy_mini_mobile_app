/**
 * RFC 8252 ("OAuth 2.0 for Native Apps") loopback flow against
 * Hugging Face for the remote-mode sign-in.
 *
 * High-level dance
 * ────────────────
 *   1. Generate PKCE pair (code_verifier + code_challenge SHA-256).
 *   2. Start the Rust loopback HTTP server on `127.0.0.1:8000` that
 *      waits for `GET /api/hf-auth/oauth/callback?code=…`. We use
 *      this exact path because it's already registered with HF for
 *      the Pollen Reachy Mini OAuth client (`71146982-…`); reusing
 *      it means we don't need to register anything new on HF's side.
 *   3. Open the system browser at HF's `/oauth/authorize` with our
 *      `client_id`, `code_challenge`, `state`, and the matching
 *      `redirect_uri`. The user signs in, HF redirects back to our
 *      loopback server, the Rust task captures `code` + `state`.
 *   4. Exchange the code for a token via POST `/oauth/token` (no
 *      client secret because PKCE; HF accepts public clients).
 *   5. Hand the token to `useRemoteHfToken` for persistence.
 *
 * Why we don't re-use a Tauri webview for this
 * ────────────────────────────────────────────
 * `huggingface.co/login` ships `X-Frame-Options: SAMEORIGIN` which
 * blocks any iframe / WebView embed of the login page. That's why
 * the daemon-mediated flow already opens the system browser; we keep
 * the same trade-off here.
 *
 * Mobile note
 * ───────────
 * On iOS/Android the same loopback server pattern works (apps can
 * bind 127.0.0.1), provided the OS keeps the app alive in the
 * background while the system browser is foregrounded. Most OS
 * versions do for at least the few seconds the OAuth round-trip
 * takes; if it ever becomes a problem we'll add a deep-link
 * fallback (`reachymini://oauth/callback`).
 */
import { invoke } from '@tauri-apps/api/core';

import { openExternalUrl } from '../utils/openUrl';

const HF_OAUTH_CLIENT_ID = '71146982-8184-45a2-b05a-d561b3cd701d';
const HF_OAUTH_REDIRECT_URI = 'http://localhost:8000/api/hf-auth/oauth/callback';
const HF_OAUTH_AUTHORIZE_URL = 'https://huggingface.co/oauth/authorize';
const HF_OAUTH_TOKEN_URL = 'https://huggingface.co/oauth/token';

// Mirrors the daemon's default scopes (see hf_auth.py). Kept in sync
// so the token we get is interchangeable with one obtained on LAN.
const HF_OAUTH_SCOPES =
  'openid profile read-repos write-repos manage-repos inference-api';

interface OAuthCallbackResult {
  code: string;
  state: string | null;
}

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

  // Kick off the loopback listener BEFORE opening the browser, so
  // there's no race where HF redirects faster than we can bind.
  const callbackPromise = invoke<OAuthCallbackResult>('start_oauth_callback', {
    expectedState: state,
  });

  // Best-effort: if the user closes the browser without completing,
  // we surface that to the UI as a Cancelled error from the Rust
  // side after FLOW_TIMEOUT (10 min). For tighter UX we expose a
  // `cancel()` helper below.
  const authorizeUrl = buildAuthorizeUrl({
    state,
    codeChallenge: pkce.challenge,
  });
  await openExternalUrl(authorizeUrl);

  const callback = await callbackPromise;

  const tokenPayload = await exchangeCodeForToken({
    code: callback.code,
    codeVerifier: pkce.verifier,
  });

  const username = await fetchUsername(tokenPayload.access_token);

  return { token: tokenPayload.access_token, username };
}

/**
 * Aborts an in-flight loopback listener. Safe to call when no flow
 * is running (no-op on the Rust side).
 */
export async function cancelLoginFlow(): Promise<void> {
  try {
    await invoke('cancel_oauth_callback');
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
  // Content-Type must be x-www-form-urlencoded per RFC 6749.
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
    const data = (await resp.json()) as { name?: string; preferred_username?: string };
    return data.preferred_username ?? data.name ?? null;
  } catch {
    return null;
  }
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
