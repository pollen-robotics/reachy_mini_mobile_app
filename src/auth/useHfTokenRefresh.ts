/**
 * Background HF access-token refresh.
 *
 * Why this exists
 * ───────────────
 * The OAuth loopback flow (`oauthLoopback.ts`) returns an access
 * token plus, when HF feels like issuing one, a `refresh_token` and
 * an `expires_in` lifetime. Without this hook the access token
 * silently expires while the user is in the app, and the next call
 * (central poll, daemon probe, etc.) hits a 401, which today
 * surfaces as a generic "token rejected" error and forces the user
 * back to the sign-in gate.
 *
 * What we do
 * ──────────
 *   1. Schedule a one-shot `setTimeout` to fire at ~80% of the
 *      access token's TTL. We don't poll on a tight interval - HF
 *      can give us a 24h-long token, polling every minute would be
 *      a complete waste of energy on a phone.
 *   2. When the timer fires, attempt a refresh:
 *      - If `refreshToken` is present → call HF's `/oauth/token`
 *        with `grant_type=refresh_token`. On success persist the
 *        new triple. On failure (HTTP 4xx) → forced sign-out.
 *      - If `refreshToken` is missing (HF didn't issue one for this
 *        client config) → emit a `token.refresh.no_refresh_token`
 *        warning, do nothing. The user will hit the sign-in gate
 *        on the next 401 and re-auth manually. We'd love to do a
 *        silent re-loopback here, but the OS browser sheet still
 *        flickers to the foreground even when HF cookies are valid,
 *        which is worse UX than an explicit gate.
 *   3. On `expiresAt` change (new sign-in / refresh / clear), the
 *      timer is reset.
 *
 * Why we don't fight HF's variable behaviour
 * ──────────────────────────────────────────
 * Some HF clients are configured to issue refresh tokens, others
 * aren't. We treat both as first-class: if `refreshToken` is null
 * the hook is a no-op, the rest of the app keeps working until the
 * user hits a 401 and is dropped at the gate.
 */
import { useEffect, useRef } from 'react';

import { createLogger } from '../logger';

import { refreshHfAccessToken } from './oauthLoopback';
import type { RemoteHfTokenState } from './useRemoteHfToken';

const logger = createLogger('auth.refresh');

/**
 * Refresh the access token at this fraction of its lifetime. 0.8 was
 * chosen to leave a 20% buffer - more than enough to retry on
 * transient network errors before the access token actually expires.
 */
const REFRESH_AT_FRACTION = 0.8;

/**
 * Floor on the schedule delay. If the token's expiry is in the past
 * (clock skew, app resumed after suspension) we still wait a few
 * seconds to avoid a thundering-herd refresh storm on resume.
 */
const MIN_REFRESH_DELAY_MS = 5_000;

/**
 * Ceiling on the schedule delay. JavaScript's `setTimeout` accepts up
 * to 2^31-1 ms (~24.8 days) before silently firing immediately on
 * some engines; we cap well below that so a long-lived token still
 * gets refreshed eventually rather than ageing out in the background.
 */
const MAX_REFRESH_DELAY_MS = 12 * 60 * 60 * 1_000; // 12h

export function useHfTokenRefresh(state: RemoteHfTokenState): void {
  const { token, refreshToken, expiresAt, setToken, clear } = state;

  // Capture the current setters in refs so the timer callback always
  // sees the latest closure without resetting the timer on every
  // render (which would defeat the schedule).
  const setTokenRef = useRef(setToken);
  const clearRef = useRef(clear);
  setTokenRef.current = setToken;
  clearRef.current = clear;

  useEffect(() => {
    if (!token) return;
    if (!expiresAt) {
      // We didn't get an `expires_in` from HF, so we can't schedule
      // anything. The user will sign in again on first 401.
      logger.debug('schedule.skipped', { reason: 'no_expiry' });
      return;
    }
    if (!refreshToken) {
      logger.warn('schedule.skipped', { reason: 'no_refresh_token' });
      return;
    }

    const now = Date.now();
    const ttlMs = expiresAt - now;
    // Refresh at 80% of the *remaining* TTL, not the original TTL,
    // so a token that's already 90% used (e.g. on app resume) still
    // refreshes promptly without a giant idle window.
    const desiredDelay = Math.floor(ttlMs * REFRESH_AT_FRACTION);
    const delay = Math.min(
      MAX_REFRESH_DELAY_MS,
      Math.max(MIN_REFRESH_DELAY_MS, desiredDelay),
    );
    logger.info('schedule.set', {
      delay_ms: delay,
      ttl_ms: ttlMs,
    });

    let cancelled = false;
    const handle = window.setTimeout(() => {
      if (cancelled) return;
      void (async () => {
        const result = await refreshHfAccessToken(refreshToken);
        if (cancelled) return;
        if (!result) {
          // HF said no. The access token is about to die anyway, so
          // the kindest thing is to drop the user at the gate now
          // rather than let them watch the next request 401 in two
          // minutes.
          logger.warn('refresh.giving_up');
          clearRef.current();
          return;
        }
        setTokenRef.current(result.token, {
          username: result.username,
          refreshToken: result.refreshToken,
          expiresInSec: result.expiresInSec,
        });
      })();
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [token, refreshToken, expiresAt]);
}
