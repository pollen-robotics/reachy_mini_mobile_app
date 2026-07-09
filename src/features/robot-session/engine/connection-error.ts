/**
 * Map a session failure (bring-up OR a mid-session fatal drop) to a
 * user-facing message WITHOUT lying about the cause.
 *
 * Used by `ConnectionController.onFatalError` so the error surface
 * never shows a raw engine string.
 */
export function formatConnectionError(detail: string): string {
  // Transport refused/dropped (network, or a mid-session drop
  // surfaced as fatal).
  if (/connection lost|disconnected/i.test(detail)) {
    return 'Lost the connection to the robot. Retry in a moment.';
  }

  // The daemon ended the session on its side (robot unplugged, daemon
  // stopped, another client took the slot).
  if (/session ended/i.test(detail)) {
    return 'The session ended unexpectedly. The robot may have been disconnected, or its daemon was stopped.';
  }

  return 'Could not reach the robot. Retry in a moment.';
}
