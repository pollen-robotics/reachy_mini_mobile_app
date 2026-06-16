/**
 * Map a realtime failure (startup OR a mid-session fatal drop) to a
 * user-facing message WITHOUT lying about the cause.
 *
 * Shared by the conversation layer (`recoverConversationStartFailure`)
 * and the connection layer (`ConnectionController.onFatalError`) so the
 * orb caption never shows a raw engine string. Both backends embed
 * structured hints in their thrown messages:
 *
 *   HF realtime:
 *     - allocator:  `HF realtime session allocator failed (<status>): ...`
 *     - websocket:  `... realtime websocket closed (<code>)` / `... failed to open`
 *   OpenAI realtime:
 *     - no token:   `no HF token in sessionStorage; sign in to Hugging Face first`
 *     - key mint:   `mint endpoint returned <status>: ...`
 *     - handshake:  `OpenAI Realtime handshake failed (<status>): ...`
 *
 * Only a rejection of the user's HF token (no token, or 401/403 on the
 * token-bearing allocator / mint requests) is a genuine "sign in again" case.
 * Everything else - a busy/cold backend, a rate limit, a dropped transport, a
 * revoked ephemeral key - is transient, where "sign in" would be a dead end.
 */
export function formatConversationError(detail: string): string {
  // OpenAI backend pre-flight: no HF token to mint a key with.
  if (/no HF token|hf_token_missing/i.test(detail)) {
    return "Sign in to Hugging Face to start the conversation.";
  }

  // HTTP status on a request that carried the user's HF token: the HF
  // realtime allocator (`allocator failed (<status>)`) or the OpenAI
  // ephemeral-key mint (`mint endpoint returned <status>`).
  const allocatorStatus = detail.match(/allocator failed \((\d{3})\)/);
  const mintStatus = detail.match(/mint endpoint returned (\d{3})/);
  if (allocatorStatus || mintStatus) {
    const status = Number(allocatorStatus?.[1] ?? mintStatus?.[1]);
    // 401/403 rejects the user's HF token itself - the only genuine
    // "sign in again" case (e.g. the mint's whoami refused the token).
    if (status === 401 || status === 403) {
      return "Hugging Face sign-in expired. Sign in again and retry.";
    }
    if (status === 429) {
      return "Rate limit reached. Wait a moment and retry.";
    }
    // A 5xx on the mint means the server accepted the HF token but its
    // upstream OpenAI mint failed (e.g. the master OpenAI key is rejected).
    // That breaks the OpenAI backend for everyone - point the user at the
    // working HF backend instead of a useless retry.
    if (mintStatus) {
      return "The OpenAI backend is unavailable right now. Switch to the Hugging Face backend.";
    }
    return "The Hugging Face realtime backend is busy. Retry in a moment.";
  }

  // Transport refused/dropped (cold backend, network, a revoked ephemeral key
  // on the OpenAI SDP handshake, or a mid-session drop surfaced as fatal) -
  // not a sign-in issue.
  if (
    /realtime websocket (closed|failed to open)|Realtime handshake failed|connection lost/i.test(
      detail,
    )
  ) {
    return "Lost the realtime connection. Retry in a moment.";
  }

  return "Could not start the conversation. Retry in a moment.";
}
