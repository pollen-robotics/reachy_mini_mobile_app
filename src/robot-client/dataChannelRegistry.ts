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
import { createLogger } from '../logger';

const logger = createLogger('webrtc.registry');

type Listener = (dc: RTCDataChannel | null) => void;

let activeChannel: RTCDataChannel | null = null;
const listeners = new Set<Listener>();

/**
 * Per-DC unique id, attached lazily by `setActiveDataChannel` so logs
 * can correlate "DC opened" / "DC closed" / "fetch on DC" entries
 * across the connect/disconnect cycle. Without this every log line
 * would just say `[object RTCDataChannel]` and we couldn't tell DC1
 * from DC2 after a reconnect.
 */
let nextDcId = 1;
const dcIds = new WeakMap<RTCDataChannel, number>();

export function getDataChannelId(dc: RTCDataChannel | null): number | null {
  if (!dc) return null;
  let id = dcIds.get(dc);
  if (id === undefined) {
    id = nextDcId++;
    dcIds.set(dc, id);
  }
  return id;
}

function describe(dc: RTCDataChannel | null): Record<string, unknown> {
  if (!dc) return { dc: null };
  return {
    dc_id: getDataChannelId(dc),
    label: dc.label,
    state: dc.readyState,
  };
}

/**
 * Publish (or clear) the active DataChannel. Pass `null` on `close`
 * so subscribers can drop in-flight state.
 */
export function setActiveDataChannel(dc: RTCDataChannel | null): void {
  if (activeChannel === dc) {
    logger.debug('set.noop', describe(dc));
    return;
  }
  const prev = activeChannel;
  activeChannel = dc;
  logger.info('set', {
    prev_dc_id: getDataChannelId(prev),
    prev_state: prev?.readyState ?? null,
    ...describe(dc),
    listener_count: listeners.size,
  });
  for (const fn of listeners) {
    try {
      fn(dc);
    } catch (err) {
      logger.warn('subscriber.threw', {
        message: err instanceof Error ? err.message : String(err),
      });
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
  logger.debug('subscribe', {
    listener_count: listeners.size,
    bootstrap_dc_id: getDataChannelId(activeChannel),
  });
  try {
    fn(activeChannel);
  } catch (err) {
    logger.warn('subscriber.threw.bootstrap', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return () => {
    listeners.delete(fn);
    logger.debug('unsubscribe', { listener_count: listeners.size });
  };
}
