/**
 * Local-only Hugging Face token storage for remote mode.
 *
 * The default (BLE) flow has the daemon hold the OAuth token: the
 * phone never sees it, and the daemon's keyring takes care of
 * persistence. That breaks the moment the phone has no LAN line of
 * sight to the daemon (cellular, public Wi-Fi, away from home), so
 * remote mode falls back to a phone-resident token.
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

function syncSessionStorage(token: string | null): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    if (token) sessionStorage.setItem('hf_token', token);
    else sessionStorage.removeItem('hf_token');
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
    syncSessionStorage(stored.token);
    return stored;
  });

  useEffect(() => {
    syncSessionStorage(token);
  }, [token]);

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
