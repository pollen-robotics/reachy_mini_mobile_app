import { useCallback, useEffect, useRef, useState } from 'react';

import { daemonFetch } from '../daemon/daemonFetch';
import { openExternalUrl } from '../utils/openUrl';

/**
 * HuggingFace authentication hook, daemon-mediated.
 *
 * Mirrors the desktop app's `useHfAuth`: the actual OAuth flow happens on
 * the robot's daemon (Python, `reachy_mini.daemon.app.routers.hf_auth`),
 * the app never sees the code or the token, it just polls
 * `GET /api/hf-auth/status` until the user has completed the login in
 * their system browser.
 *
 * Flow on mobile:
 *
 *   1. App calls `GET /api/hf-auth/oauth/start` on the daemon (via the
 *      Rust `daemon_fetch` proxy). The daemon creates an OAuth session
 *      and returns an `auth_url` pointing at
 *      `https://huggingface.co/oauth/authorize?...` with a redirect URI
 *      of `http://reachy-mini.local:8000/api/hf-auth/oauth/callback`.
 *
 *   2. The app opens that URL in the **system browser** via
 *      `tauri-plugin-opener`. Critically, this avoids embedding
 *      `huggingface.co/login` (which sends `X-Frame-Options: SAMEORIGIN`)
 *      inside any WebView iframe, and lets the user benefit from their
 *      existing HF cookies / 2FA.
 *
 *   3. The user authenticates in the browser. HuggingFace redirects to
 *      the daemon callback. The daemon stores the token locally.
 *
 *   4. Meanwhile the app polls `GET /api/hf-auth/status` every
 *      `AUTH_POLL_INTERVAL_MS`. As soon as `is_logged_in: true` is
 *      returned, polling stops and the UI updates.
 *
 * Callback URL caveat: the daemon only registers two redirect URIs with
 * HuggingFace (`reachy-mini.local` and `localhost`). Both iOS and modern
 * Android resolve `.local` via mDNS on the same WiFi as the robot, so
 * this works as long as the phone is on the robot's subnet when the
 * callback fires. If resolution fails the user sees the HF page time out
 * and can cancel; we do not attempt a fallback.
 */

/** How often we poll `/status` while waiting for the OAuth to complete. */
const AUTH_POLL_INTERVAL_MS = 2_000;

/** Give the user five minutes to complete login in their browser. */
const AUTH_POLL_TIMEOUT_MS = 5 * 60 * 1_000;

type TimeoutId = ReturnType<typeof setTimeout>;
type IntervalId = ReturnType<typeof setInterval>;

export interface HfAuthState {
  isAuthenticated: boolean;
  username: string | null;
  avatarUrl: string | null;
  /** `true` while the initial status probe is in flight. */
  isLoading: boolean;
  /** `true` between opening the browser and seeing `is_logged_in: true`. */
  isWaitingForAuth: boolean;
  error: string | null;
}

export interface UseHfAuthResult extends HfAuthState {
  refresh: () => Promise<void>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  cancelWaiting: () => void;
}

interface HfAuthStatusPayload {
  is_logged_in: boolean;
  username?: string | null;
  avatar_url?: string | null;
}

interface HfOAuthStartPayload {
  auth_url?: string;
}

/**
 * @param host - daemon host (IP or `reachy-mini.local`). When null the
 *   hook stays idle and exposes `isAuthenticated: false`; callers should
 *   gate the login button on a non-null host.
 */
export function useHfAuth(host: string | null): UseHfAuthResult {
  const [state, setState] = useState<HfAuthState>({
    isAuthenticated: false,
    username: null,
    avatarUrl: null,
    isLoading: false,
    isWaitingForAuth: false,
    error: null,
  });

  const pollIntervalRef = useRef<IntervalId | null>(null);
  const pollTimeoutRef = useRef<TimeoutId | null>(null);
  const mountedRef = useRef(true);

  const stopPolling = useCallback((): void => {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (pollTimeoutRef.current !== null) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    if (mountedRef.current) {
      setState(s => ({ ...s, isWaitingForAuth: false }));
    }
  }, []);

  const applyStatus = useCallback((payload: HfAuthStatusPayload): boolean => {
    const username = payload.username ?? null;
    const avatarUrl =
      payload.avatar_url ??
      (username ? `https://huggingface.co/api/users/${username}/avatar` : null);

    setState(s => ({
      ...s,
      isAuthenticated: payload.is_logged_in,
      username,
      avatarUrl,
    }));
    return payload.is_logged_in;
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!host) return;
    try {
      const response = await daemonFetch<HfAuthStatusPayload>(host, '/api/hf-auth/status', {
        timeoutMs: 4_000,
      });
      if (response.ok && response.data) {
        applyStatus(response.data);
      }
    } catch {
      // Daemon may not expose this endpoint yet (old firmware) - stay silent.
    }
  }, [host, applyStatus]);

  useEffect(() => {
    mountedRef.current = true;
    if (host) void refresh();
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [host, refresh, stopPolling]);

  const login = useCallback(async (): Promise<void> => {
    if (!host) return;
    if (state.isWaitingForAuth || state.isLoading) return;

    setState(s => ({ ...s, isLoading: true, error: null }));

    try {
      const startResp = await daemonFetch<HfOAuthStartPayload>(host, '/api/hf-auth/oauth/start', {
        method: 'GET',
        timeoutMs: 8_000,
      });

      if (!startResp.ok) {
        const detail =
          (startResp.data as { detail?: string } | null)?.detail ??
          `OAuth start failed (${startResp.status})`;
        throw new Error(detail);
      }

      const authUrl = startResp.data?.auth_url;
      if (!authUrl) throw new Error('Daemon did not return an auth URL');

      await openExternalUrl(authUrl);

      setState(s => ({ ...s, isLoading: false, isWaitingForAuth: true }));

      // Kick off the polling loop. The first tick fires after the
      // interval, not immediately, which is what we want: the user needs
      // a second to even see the browser tab.
      pollIntervalRef.current = setInterval(() => {
        void (async () => {
          try {
            const probe = await daemonFetch<HfAuthStatusPayload>(host, '/api/hf-auth/status', {
              timeoutMs: 4_000,
            });
            if (probe.ok && probe.data && applyStatus(probe.data)) {
              stopPolling();
            }
          } catch {
            // Ignore single polling failures (flaky WiFi, daemon restart, etc.).
          }
        })();
      }, AUTH_POLL_INTERVAL_MS);

      pollTimeoutRef.current = setTimeout(() => {
        stopPolling();
      }, AUTH_POLL_TIMEOUT_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OAuth start failed';
      setState(s => ({
        ...s,
        isLoading: false,
        isWaitingForAuth: false,
        error: message,
      }));
    }
  }, [host, state.isLoading, state.isWaitingForAuth, applyStatus, stopPolling]);

  const logout = useCallback(async (): Promise<void> => {
    if (!host) return;
    try {
      await daemonFetch(host, '/api/hf-auth/token', {
        method: 'DELETE',
        timeoutMs: 4_000,
      });
      setState(s => ({
        ...s,
        isAuthenticated: false,
        username: null,
        avatarUrl: null,
      }));
    } catch {
      // Re-sync state if the DELETE failed but the token actually went away.
      await refresh();
    }
  }, [host, refresh]);

  return {
    ...state,
    refresh,
    login,
    logout,
    cancelWaiting: stopPolling,
  };
}
