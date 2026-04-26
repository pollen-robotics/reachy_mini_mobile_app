/**
 * Tiny pub/sub registry for the WebRTC DataChannel shared between the
 * Reachy SDK and our `WebRtcRobotClient`.
 *
 * Why a singleton?
 * ────────────────
 * The DataChannel is created once per session by the daemon (in the
 * GStreamer / aiortc producer). The Reachy SDK receives it via
 * `pc.ondatachannel` and uses it for its own typed commands. Our
 * `WebRtcRobotClient` needs to send `http_proxy` payloads on the
 * SAME channel - we cannot open a parallel DC after-the-fact without
 * an SDP renegotiation we don't control. Hence: capture the SDK's
 * DC, expose it, dispatch responses by `request_id`.
 *
 * Lifecycle:
 *   - `useReachySdk`'s patched RTCPeerConnection wrapper sets the DC
 *     here when the SDK opens a session.
 *   - The DC's own `close` handler clears the slot so dangling
 *     clients see `null` instead of a half-dead channel.
 *   - Subscribers (the WebRTC client's response listener) re-attach
 *     on every replacement.
 */
type Listener = (dc: RTCDataChannel | null) => void;

let activeChannel: RTCDataChannel | null = null;
const listeners = new Set<Listener>();

/**
 * Publish (or clear) the active DataChannel. Pass `null` on `close`
 * so subscribers can drop in-flight state.
 */
export function setActiveDataChannel(dc: RTCDataChannel | null): void {
  if (activeChannel === dc) return;
  activeChannel = dc;
  for (const fn of listeners) {
    try {
      fn(dc);
    } catch (err) {
      console.warn('[robot-client] DC subscriber threw', err);
    }
  }
}

/**
 * Read the current DC. Returns `null` when no session is active or
 * when the SDK has just torn the channel down.
 */
export function getActiveDataChannel(): RTCDataChannel | null {
  return activeChannel;
}

/**
 * Subscribe to DC changes. The callback is invoked once with the
 * current value (so callers don't need to bootstrap manually) and
 * again on every subsequent set/clear.
 *
 * Returns an unsubscribe function. Safe to call from React effects.
 */
export function subscribeDataChannel(fn: Listener): () => void {
  listeners.add(fn);
  try {
    fn(activeChannel);
  } catch (err) {
    console.warn('[robot-client] DC subscriber threw on bootstrap', err);
  }
  return () => {
    listeners.delete(fn);
  };
}
