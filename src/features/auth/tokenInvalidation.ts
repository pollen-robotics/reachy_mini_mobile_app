/**
 * Cross-cutting signal for "the HF token was rejected by Hugging Face".
 *
 * Why this exists
 * ───────────────
 * The auth gate in `App.tsx` only evicts a token whose JWT `exp` is
 * already in the past (`isHfTokenExpired`). But HF can reject a token
 * that still LOOKS valid locally: an OAuth JWT whose signature no longer
 * verifies after a key rotation, or an opaque token we can't introspect.
 * In those cases every direct HF call (router chat/vision, whoami) 401s
 * with no in-app way to recover - the user is stuck seeing
 * "signature verification failed" forever.
 *
 * Rather than thread a React callback down through the router transport
 * (used by both personality generation and the vision provider), the
 * transport emits a decoupled window event when it sees a hard auth
 * rejection (HTTP 401). The app shell listens once and clears the token,
 * which flips the auth gate back to the sign-in screen so the user
 * re-authenticates into a fresh token. Same custom-event pattern already
 * used for `reachymini:ready`.
 *
 * We deliberately fire ONLY on 401 (bad/expired credentials), never on
 * 403 (insufficient scope): a 403 wouldn't be fixed by re-signing-in with
 * the same scopes and would risk a sign-in loop.
 */

export const HF_TOKEN_INVALID_EVENT = "reachymini:hf-token-invalid";

/**
 * Announce that Hugging Face rejected the current token (HTTP 401).
 * Safe to call from non-React transport code; a no-op outside a DOM.
 */
export function notifyHfTokenInvalid(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(HF_TOKEN_INVALID_EVENT));
  } catch {
    // dispatchEvent can throw in exotic embeddings; recovery is
    // best-effort and the raw 401 still surfaces to the caller.
  }
}

/**
 * Subscribe to token-invalidation signals. Returns an unsubscribe fn
 * suited to a React `useEffect` cleanup.
 */
export function onHfTokenInvalid(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(HF_TOKEN_INVALID_EVENT, handler);
  return () => window.removeEventListener(HF_TOKEN_INVALID_EVENT, handler);
}
