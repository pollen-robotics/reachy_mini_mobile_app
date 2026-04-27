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
 * (plus `hf_username` and `hf_token_expires` - see `syncSessionStorage`
 * below for why all three are required). When we hydrate from
 * localStorage on app start, we mirror the values into
 * sessionStorage so the SDK picks them up on first `authenticate()`
 * without any further plumbing. This is the single source of truth
 * for SDK seeding in the app; nothing else writes those keys.
 */
import { useCallback, useEffect, useState } from 'react';

import { createLogger } from '../logger';

const logger = createLogger('auth.token');

const STORAGE_KEY = 'remote_hf_token';
const USERNAME_KEY = 'remote_hf_username';
// PR-D adds two optional fields. Older app versions just ignore them
// (and fall through to "no expiry tracking, no auto-refresh"), so the
// migration is a no-op.
const REFRESH_TOKEN_KEY = 'remote_hf_refresh_token';
const EXPIRES_AT_KEY = 'remote_hf_expires_at';

interface StoredAuth {
  token: string | null;
  username: string | null;
  refreshToken: string | null;
  /** Epoch ms when the access token expires, or `null` if HF didn't tell us. */
  expiresAt: number | null;
}

function readStored(): StoredAuth {
  if (typeof localStorage === 'undefined') {
    return { token: null, username: null, refreshToken: null, expiresAt: null };
  }
  try {
    const expiresRaw = localStorage.getItem(EXPIRES_AT_KEY);
    const expiresAt = expiresRaw ? Number(expiresRaw) : null;
    return {
      token: localStorage.getItem(STORAGE_KEY),
      username: localStorage.getItem(USERNAME_KEY),
      refreshToken: localStorage.getItem(REFRESH_TOKEN_KEY),
      expiresAt:
        expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt : null,
    };
  } catch {
    return { token: null, username: null, refreshToken: null, expiresAt: null };
  }
}

function writeStored(next: StoredAuth): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (next.token) localStorage.setItem(STORAGE_KEY, next.token);
    else localStorage.removeItem(STORAGE_KEY);
    if (next.username) localStorage.setItem(USERNAME_KEY, next.username);
    else localStorage.removeItem(USERNAME_KEY);
    if (next.refreshToken)
      localStorage.setItem(REFRESH_TOKEN_KEY, next.refreshToken);
    else localStorage.removeItem(REFRESH_TOKEN_KEY);
    if (next.expiresAt !== null)
      localStorage.setItem(EXPIRES_AT_KEY, String(next.expiresAt));
    else localStorage.removeItem(EXPIRES_AT_KEY);
  } catch {
    // localStorage can be unavailable in private browsing;
    // failing to persist is recoverable, the user just has to
    // paste the token again next launch.
  }
}

/**
 * Mirror the OAuth session into `sessionStorage` so the reachy-mini
 * SDK's `authenticate()` call succeeds without bouncing through the
 * HF redirect flow.
 *
 * The SDK requires **all three** of:
 *   - `hf_token`            (bearer)
 *   - `hf_username`         (display name shown next to the orb)
 *   - `hf_token_expires`    (must `new Date()`-parse and be in the future)
 *
 * Seeding only `hf_token` makes `authenticate()` silently return false
 * and the engine state machine stays stuck in `"signed-out"` even
 * though the daemon and central agree we're authenticated. This
 * helper is the single canonical write path for those three
 * sessionStorage keys, called both on hydration and on every token
 * change so the SDK picks up the session on first `ConversePanel`
 * mount.
 *
 * `expiresAt` is stored in localStorage as an epoch-ms number; the
 * SDK however parses with `new Date(value)`, so we hand it back as
 * an ISO 8601 string. When we don't have an expiry (legacy storage
 * or HF didn't return `expires_in`), we fall back to "now + 1h":
 * the SDK only checks the field is a future date, and the next
 * `central-robot-status` round-trip will surface a 401 anyway if the
 * token has actually expired, so a generous default is harmless.
 */
function syncSessionStorage(
  token: string | null,
  username: string | null,
  expiresAt: number | null,
): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    if (token) {
      sessionStorage.setItem('hf_token', token);
      sessionStorage.setItem('hf_username', username ?? '');
      const exp = expiresAt ?? Date.now() + 60 * 60 * 1000;
      sessionStorage.setItem('hf_token_expires', new Date(exp).toISOString());
    } else {
      sessionStorage.removeItem('hf_token');
      sessionStorage.removeItem('hf_username');
      sessionStorage.removeItem('hf_token_expires');
    }
  } catch {
    // mirror localStorage's silent failure, see above
  }
}

export interface SetTokenOptions {
  username?: string | null;
  /** Refresh token issued alongside the access token, when HF returns one. */
  refreshToken?: string | null;
  /** Lifetime of the access token in seconds (HF's `expires_in` field). */
  expiresInSec?: number | null;
}

export interface RemoteHfTokenState {
  token: string | null;
  username: string | null;
  refreshToken: string | null;
  /** Epoch ms when the access token expires, or `null` if unknown. */
  expiresAt: number | null;
  setToken: (token: string, opts?: SetTokenOptions) => void;
  clear: () => void;
}

export function useRemoteHfToken(): RemoteHfTokenState {
  // Seed both states AND sessionStorage in the initializer so the
  // SDK can read `sessionStorage.hf_token` on the very first render
  // of any descendant component (no useEffect race window).
  const [{ token, username, refreshToken, expiresAt }, setState] = useState(
    () => {
      const stored = readStored();
      syncSessionStorage(stored.token, stored.username, stored.expiresAt);
      return stored;
    },
  );

  useEffect(() => {
    syncSessionStorage(token, username, expiresAt);
  }, [token, username, expiresAt]);

  const setToken = useCallback(
    (nextToken: string, opts: SetTokenOptions = {}) => {
      const cleanToken = nextToken.trim() || null;
      const cleanUsername = opts.username ?? null;
      const cleanRefresh = opts.refreshToken ?? null;
      // HF returns `expires_in` in seconds. Store an absolute epoch ms
      // (rather than the relative `expiresIn`) so a hot-reload or page
      // navigation doesn't reset the countdown.
      const cleanExpiresAt =
        opts.expiresInSec && opts.expiresInSec > 0
          ? Date.now() + opts.expiresInSec * 1000
          : null;
      const next: StoredAuth = {
        token: cleanToken,
        username: cleanUsername,
        refreshToken: cleanRefresh,
        expiresAt: cleanExpiresAt,
      };
      writeStored(next);
      logger.info('token.set', {
        username: cleanUsername,
        has_refresh: cleanRefresh !== null,
        expires_at: cleanExpiresAt,
      });
      setState(next);
    },
    [],
  );

  const clear = useCallback(() => {
    writeStored({
      token: null,
      username: null,
      refreshToken: null,
      expiresAt: null,
    });
    logger.info('token.clear');
    setState({
      token: null,
      username: null,
      refreshToken: null,
      expiresAt: null,
    });
  }, []);

  return { token, username, refreshToken, expiresAt, setToken, clear };
}
