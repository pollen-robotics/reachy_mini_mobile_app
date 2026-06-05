/**
 * Local-only Hugging Face token storage.
 *
 * The phone holds the OAuth token in localStorage. There is no
 * daemon-mediated keyring path in the mobile shell: every connection
 * is brokered through the HF central signaling Space, which expects
 * a phone-resident bearer.
 *
 * Threat model
 * ────────────
 * `localStorage` on Tauri WebView is per-app, not shared with the
 * system browser, and not synced anywhere. The token never leaves
 * the device unless the user explicitly pastes it into HTTPS
 * requests we initiate (whoami, central robot-status, signaling
 * SSE). Loss of the device equates to loss of the token; the user
 * can revoke it on their HF account at any time.
 *
 * Sync seeding into `sessionStorage`
 * ──────────────────────────────────
 * The reachy-mini SDK reads its bearer from `sessionStorage.hf_token`
 * (set by `seedHfToken` in `useReachySdk`). When we hydrate from
 * localStorage on app start, we also push the value into
 * sessionStorage so the SDK picks it up without any further
 * plumbing — same trick the daemon-mediated flow uses, just
 * sourced from a different place.
 */
import { useCallback, useEffect, useState } from 'react';

import { DEV_HF_TOKEN, DEV_HF_USERNAME } from '@/shared/env';

const STORAGE_KEY = 'remote_hf_token';
const USERNAME_KEY = 'remote_hf_username';

function readStored(): { token: string | null; username: string | null } {
  if (typeof localStorage === 'undefined') {
    return { token: null, username: null };
  }
  try {
    return {
      token: localStorage.getItem(STORAGE_KEY),
      username: localStorage.getItem(USERNAME_KEY),
    };
  } catch {
    return { token: null, username: null };
  }
}

function writeStored(token: string | null, username: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
    if (username) localStorage.setItem(USERNAME_KEY, username);
    else localStorage.removeItem(USERNAME_KEY);
  } catch {
    // localStorage can be unavailable in private browsing;
    // failing to persist is recoverable, the user just has to
    // paste the token again next launch.
  }
}

/** Far-future expiry stamp for the SDK's sessionStorage check.
 *
 * The SDK's `authenticate()` rejects the cached token unless
 * `new Date(hf_token_expires) > new Date()`. Personal access tokens
 * (the most common case here) don't carry an expiry, and the
 * daemon-mediated OAuth tokens are long-lived too, so we hand the
 * SDK a date a year out. If the actual server-side token ends up
 * being rejected we'll see it as a 401 on the first authenticated
 * call, not as a bogus "auth ok then fails immediately" race.
 */
const HF_TOKEN_FAR_FUTURE_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

function syncSessionStorage(token: string | null, username: string | null): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    if (token) {
      sessionStorage.setItem('hf_token', token);
      // The SDK's `authenticate()` requires ALL three fields in
      // sessionStorage to fast-path the cached token: bearer,
      // username, and a not-yet-elapsed expiry. Username comes from
      // our own state (when we have it); when we don't (token-only
      // login path), we seed a placeholder so the check passes - the
      // SDK only uses this field for display purposes via
      // `robot.username`, which the engine already rebroadcasts via
      // its own callbacks.
      sessionStorage.setItem('hf_username', username ?? 'user');
      sessionStorage.setItem(
        'hf_token_expires',
        new Date(Date.now() + HF_TOKEN_FAR_FUTURE_EXPIRY_MS).toISOString(),
      );
    } else {
      sessionStorage.removeItem('hf_token');
      sessionStorage.removeItem('hf_username');
      sessionStorage.removeItem('hf_token_expires');
    }
  } catch {
    // mirror localStorage's silent failure, see above
  }
}

export interface RemoteHfTokenState {
  token: string | null;
  username: string | null;
  setToken: (token: string, username?: string | null) => void;
  clear: () => void;
}

export function useRemoteHfToken(): RemoteHfTokenState {
  // Seed both states AND sessionStorage in the initializer so the
  // SDK can read `sessionStorage.hf_token` on the very first render
  // of any descendant component (no useEffect race window).
  const [{ token, username }, setState] = useState(() => {
    const stored = readStored();
    // Dev-only fallback: when nothing is persisted yet and a
    // `VITE_DEV_HF_TOKEN` is configured (desktop `tauri:dev`, where
    // the in-app OAuth session does not exist), seed it as if the
    // user had just signed in. Persisting it means a later `clear()`
    // (sign-out) still wins for the rest of the session instead of
    // the env token re-seeding on every render. `DEV_HF_TOKEN` is
    // `null` in production builds (see `shared/env.ts`).
    if (!stored.token && DEV_HF_TOKEN) {
      writeStored(DEV_HF_TOKEN, DEV_HF_USERNAME);
      syncSessionStorage(DEV_HF_TOKEN, DEV_HF_USERNAME);
      return { token: DEV_HF_TOKEN, username: DEV_HF_USERNAME };
    }
    syncSessionStorage(stored.token, stored.username);
    return stored;
  });

  useEffect(() => {
    syncSessionStorage(token, username);
  }, [token, username]);

  const setToken = useCallback((nextToken: string, nextUsername?: string | null) => {
    const cleanToken = nextToken.trim();
    const cleanUsername = nextUsername ?? null;
    writeStored(cleanToken || null, cleanUsername);
    setState({ token: cleanToken || null, username: cleanUsername });
  }, []);

  const clear = useCallback(() => {
    writeStored(null, null);
    setState({ token: null, username: null });
  }, []);

  return { token, username, setToken, clear };
}
