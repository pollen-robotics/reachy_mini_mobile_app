/**
 * Map a realtime failure (startup OR a mid-session fatal drop) to a
 * user-facing message WITHOUT lying about the cause.
 *
 * Shared by the conversation layer (`recoverConversationStartFailure`)
 * and the connection layer (`ConnectionController.onFatalError`) so the
 * orb caption never shows a raw engine string. The Hugging Face realtime
 * backend embeds structured hints in its thrown messages:
 *
 *   - no token:   `no HF token in sessionStorage; sign in to Hugging Face first`
 *   - allocator:  `HF realtime session allocator failed (<status>): ...`
 *   - websocket:  `... realtime websocket closed (<code>)` / `... failed to open`
 *
 * Only a rejection of the user's HF token (no token, or 401/403 on the
 * token-bearing allocator request) is a genuine "sign in again" case.
 * Everything else - a busy/cold backend, a rate limit, a dropped
 * transport - is transient, where "sign in" would be a dead end.
 */
export function formatConversationError(
  detail: string,
  /**
   * Copy for details that match none of the structured hints below.
   * The conversation layer keeps the default; the CONNECTION layer
   * passes a transport-flavored fallback, because every error routed
   * through it is by definition a robot-link failure - "could not
   * start the conversation" would be wrong (and alarming) mid-session.
   */
  fallback = "Could not start the conversation. Retry in a moment.",
): string {
  // Pre-flight: no HF token to authenticate the session with.
  if (/no HF token|hf_token_missing/i.test(detail)) {
    return "Sign in to Hugging Face to start the conversation.";
  }

  // HTTP status on the token-bearing HF realtime allocator request.
  const allocatorStatus = detail.match(/allocator failed \((\d{3})\)/);
  if (allocatorStatus) {
    const status = Number(allocatorStatus[1]);
    // 401/403 rejects the user's HF token itself - the only genuine
    // "sign in again" case.
    if (status === 401 || status === 403) {
      return "Hugging Face sign-in expired. Sign in again and retry.";
    }
    if (status === 429) {
      return "Rate limit reached. Wait a moment and retry.";
    }
    return "The Hugging Face realtime backend is busy. Retry in a moment.";
  }

  // Transport refused/dropped (cold backend, network, or a mid-session
  // drop surfaced as fatal) - not a sign-in issue.
  if (
    /realtime websocket (closed|failed to open)|connection lost/i.test(detail)
  ) {
    return "Lost the realtime connection. Retry in a moment.";
  }

  // Central's concurrency gate: someone else (another phone, the web
  // host, a local Python app) holds the robot's single session slot.
  // Surfacing this as a generic "connection lost" would hide the one
  // piece of information that makes the retry button useful: free the
  // robot elsewhere first. Matches the SDK's `_failSessionRejected` /
  // `_handleEndSession` wording (`Robot is busy: ...`).
  if (/robot is busy|robot_busy/i.test(detail)) {
    return "Your Reachy is busy with another app. Close it there, then try again.";
  }

  return fallback;
}
