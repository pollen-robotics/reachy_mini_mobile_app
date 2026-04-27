/**
 * WebSocket transport for `RobotClient`, parallel to `webrtcClient.ts`.
 *
 * Sends `ws_open` / `ws_send` / `ws_close` commands on the same
 * WebRTC DataChannel that `http_proxy` uses, multiplexed by an
 * opaque `stream_id` we mint per call. The daemon-side handler
 * (see `reachy_mini.daemon.backend.abstract.Backend
 * ._async_ws_proxy_open`) bridges the call to a real
 * `ws://localhost:{port}{path}` aiohttp WebSocket, then pumps every
 * server frame back as `ws_message`.
 *
 * Why a separate dispatcher?
 * ──────────────────────────
 * `webrtcClient.ts` has its own `pending` map keyed on `request_id`
 * for one-shot HTTP responses. The WS lifecycle is many-frames-
 * per-stream, so it needs its own state container. Both modules
 * `addEventListener('message')` on the same DC; each filters on the
 * `parsed.type` it cares about and returns early for everything
 * else - they never collide.
 *
 * Lifecycle invariants
 * ────────────────────
 *   - `dispatcher` is installed exactly once per DC instance via the
 *     same `subscribeDataChannel` registry the http_proxy uses, and
 *     re-attached transparently on DC replacement.
 *   - When the DC closes, every live stream gets a synthetic `error`
 *     + `close(1006, 'webrtc data channel closed')` so callers don't
 *     have to listen on the DC themselves.
 *   - `close()` is always idempotent, including in racy paths where
 *     a `ws_closed` from the server arrives one tick after the user
 *     called `close()` locally.
 */
import { createLogger, getTraceId } from '../logger';
import {
  getActiveDataChannel,
  getDataChannelId,
  subscribeDataChannel,
} from './dataChannelRegistry';
import type {
  RobotWebSocket,
  RobotWebSocketCloseEvent,
  RobotWebSocketErrorEvent,
  RobotWebSocketEventMap,
  RobotWebSocketMessageEvent,
  RobotWebSocketOptions,
  RobotWebSocketReadyState,
} from './types';

const logger = createLogger('webrtc.ws_proxy');

// ─── Wire format ─────────────────────────────────────────────────────────

interface WsOpenedMsg {
  type: 'ws_opened';
  stream_id: string;
}
interface WsMessageMsg {
  type: 'ws_message';
  stream_id: string;
  data: string;
}
interface WsClosedMsg {
  type: 'ws_closed';
  stream_id: string;
  code: number;
  reason: string;
}
interface WsErrorMsg {
  type: 'ws_error';
  stream_id: string;
  error: string;
}
type WsProxyDownMsg = WsOpenedMsg | WsMessageMsg | WsClosedMsg | WsErrorMsg;

const WS_PROXY_DOWN_TYPES = new Set<WsProxyDownMsg['type']>([
  'ws_opened',
  'ws_message',
  'ws_closed',
  'ws_error',
]);

// ─── Stream registry ─────────────────────────────────────────────────────

interface StreamEntry {
  stream: RobotWebSocketImpl;
}

const streams = new Map<string, StreamEntry>();
let attachedChannel: RTCDataChannel | null = null;
let registrySubscribed = false;

function attachToChannel(dc: RTCDataChannel | null): void {
  if (dc === attachedChannel) {
    logger.debug('attach.noop', {
      dc_id: getDataChannelId(dc),
      stream_count: streams.size,
    });
    return;
  }
  const prev = attachedChannel;
  attachedChannel = dc;
  logger.info('attach', {
    prev_dc_id: getDataChannelId(prev),
    new_dc_id: getDataChannelId(dc),
    new_state: dc?.readyState ?? null,
    stream_count: streams.size,
  });
  if (!dc) {
    failAllStreams('webrtc data channel detached');
    return;
  }
  dc.addEventListener('message', handleDataChannelMessage);
  dc.addEventListener('close', () => {
    logger.info('dc.close', {
      dc_id: getDataChannelId(dc),
      was_active: attachedChannel === dc,
      stream_count: streams.size,
    });
    if (attachedChannel === dc) attachedChannel = null;
    failAllStreams('webrtc data channel closed');
  });
}

function ensureRegistrySubscribed(): void {
  if (registrySubscribed) return;
  registrySubscribed = true;
  logger.debug('registry.subscribe');
  subscribeDataChannel(dc => attachToChannel(dc));
}

function handleDataChannelMessage(evt: Event): void {
  const data = (evt as MessageEvent).data;
  if (typeof data !== 'string') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('type' in parsed) ||
    typeof (parsed as { type: unknown }).type !== 'string'
  ) {
    return;
  }
  const type = (parsed as { type: string }).type;
  if (!WS_PROXY_DOWN_TYPES.has(type as WsProxyDownMsg['type'])) {
    return;
  }
  const msg = parsed as WsProxyDownMsg;
  const entry = streams.get(msg.stream_id);
  if (!entry) {
    // We already cleaned up locally (timeout, user close()) and the
    // server is still draining frames. Drop them silently.
    return;
  }
  entry.stream._dispatchProxyFrame(msg);
}

function failAllStreams(reason: string): void {
  if (streams.size === 0) return;
  logger.warn('streams.fail_all', {
    reason,
    count: streams.size,
    stream_ids: Array.from(streams.keys()),
  });
  // Snapshot before iterating: each `_localFail` removes the entry.
  for (const [, entry] of Array.from(streams)) {
    entry.stream._localFail(reason);
  }
}

function nextStreamId(): string {
  const c = (
    globalThis as unknown as {
      crypto?: { randomUUID?: () => string };
    }
  ).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── RobotWebSocket implementation ───────────────────────────────────────

type Listeners = {
  open: Set<(ev: void) => void>;
  message: Set<(ev: RobotWebSocketMessageEvent) => void>;
  close: Set<(ev: RobotWebSocketCloseEvent) => void>;
  error: Set<(ev: RobotWebSocketErrorEvent) => void>;
};

class RobotWebSocketImpl implements RobotWebSocket {
  readonly path: string;
  private _readyState: RobotWebSocketReadyState = 'connecting';
  private readonly streamId: string;
  private readonly listeners: Listeners = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };

  constructor(path: string, streamId: string) {
    this.path = path;
    this.streamId = streamId;
  }

  get readyState(): RobotWebSocketReadyState {
    return this._readyState;
  }

  send(data: string): void {
    if (this._readyState !== 'open') {
      logger.warn('send.not_open', {
        stream_id: this.streamId,
        state: this._readyState,
        size: data.length,
      });
      return;
    }
    const dc = getActiveDataChannel();
    if (!dc || dc.readyState !== 'open') {
      // The DC's `close` handler will fire `failAllStreams` shortly;
      // we just drop the send and let the close event propagate.
      logger.warn('send.no_dc', {
        stream_id: this.streamId,
        dc_state: dc?.readyState ?? null,
      });
      return;
    }
    try {
      dc.send(
        JSON.stringify({
          type: 'ws_send',
          stream_id: this.streamId,
          data,
        }),
      );
    } catch (err) {
      logger.error('send.error', {
        stream_id: this.streamId,
        message: err instanceof Error ? err.message : String(err),
      });
      this._localFail(
        `dc.send failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  close(code?: number, reason?: string): void {
    if (this._readyState === 'closing' || this._readyState === 'closed') return;
    const prev = this._readyState;
    this._readyState = 'closing';
    logger.info('close.local', {
      stream_id: this.streamId,
      path: this.path,
      prev_state: prev,
      code: code ?? 1000,
      reason: reason ?? '',
    });

    // Best-effort send. If the DC is gone the daemon will eventually
    // GC its stream; meanwhile we want to surface a `close` event
    // locally without waiting on the round-trip.
    const dc = getActiveDataChannel();
    if (dc && dc.readyState === 'open') {
      try {
        dc.send(
          JSON.stringify({
            type: 'ws_close',
            stream_id: this.streamId,
            code: code ?? 1000,
            reason: reason ?? '',
          }),
        );
      } catch (err) {
        logger.warn('close.send_failed', {
          stream_id: this.streamId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // If the user calls close() before the handshake landed (state
    // was 'connecting'), we still want a synchronous-ish close event
    // so React effect cleanups can move on. We schedule it as a
    // microtask so listeners attached on the same tick see it.
    if (prev === 'connecting') {
      Promise.resolve().then(() => {
        if (this._readyState !== 'closed') {
          this._finalizeClose({
            code: code ?? 1000,
            reason: reason ?? '',
            wasClean: false,
          });
        }
      });
    }
  }

  addEventListener<K extends keyof RobotWebSocketEventMap>(
    type: K,
    listener: (ev: RobotWebSocketEventMap[K]) => void,
  ): void {
    (this.listeners[type] as Set<(ev: RobotWebSocketEventMap[K]) => void>).add(
      listener,
    );
  }

  removeEventListener<K extends keyof RobotWebSocketEventMap>(
    type: K,
    listener: (ev: RobotWebSocketEventMap[K]) => void,
  ): void {
    (
      this.listeners[type] as Set<(ev: RobotWebSocketEventMap[K]) => void>
    ).delete(listener);
  }

  /** Dispatch a snapshot of listeners; safe against in-handler mutation. */
  private _emit<K extends keyof RobotWebSocketEventMap>(
    type: K,
    ev: RobotWebSocketEventMap[K],
  ): void {
    const snap = Array.from(
      this.listeners[type] as Set<(ev: RobotWebSocketEventMap[K]) => void>,
    );
    for (const fn of snap) {
      try {
        fn(ev);
      } catch (err) {
        logger.warn('listener.threw', {
          stream_id: this.streamId,
          type,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Called by the dispatcher when a daemon → client frame arrives.
  _dispatchProxyFrame(msg: WsProxyDownMsg): void {
    switch (msg.type) {
      case 'ws_opened':
        if (this._readyState !== 'connecting') {
          logger.warn('opened.unexpected_state', {
            stream_id: this.streamId,
            state: this._readyState,
          });
          return;
        }
        this._readyState = 'open';
        logger.info('opened', { stream_id: this.streamId, path: this.path });
        this._emit('open', undefined);
        return;
      case 'ws_message':
        if (this._readyState !== 'open') return;
        this._emit('message', { data: msg.data });
        return;
      case 'ws_error':
        // Surface the error then synthesise a close - the daemon
        // will follow up with `ws_closed` but we don't want to wait
        // since some handshake errors never land a `ws_closed`.
        logger.warn('error', {
          stream_id: this.streamId,
          path: this.path,
          error: msg.error,
        });
        this._emit('error', { error: msg.error });
        if (this._readyState !== 'closed') {
          this._finalizeClose({
            code: 1006,
            reason: msg.error,
            wasClean: false,
          });
        }
        return;
      case 'ws_closed':
        logger.info('closed.remote', {
          stream_id: this.streamId,
          path: this.path,
          code: msg.code,
          reason: msg.reason,
        });
        if (this._readyState === 'closed') return;
        this._finalizeClose({
          code: msg.code,
          reason: msg.reason,
          wasClean: true,
        });
        return;
    }
  }

  /**
   * Local-side failure (DC dropped, dc.send threw, immediate-failure
   * branch in `openRobotWebSocket`). Emits `error` then `close`.
   */
  _localFail(reason: string): void {
    if (this._readyState === 'closed') return;
    logger.warn('local_fail', {
      stream_id: this.streamId,
      path: this.path,
      state: this._readyState,
      reason,
    });
    this._emit('error', { error: reason });
    this._finalizeClose({ code: 1006, reason, wasClean: false });
  }

  private _finalizeClose(ev: RobotWebSocketCloseEvent): void {
    this._readyState = 'closed';
    streams.delete(this.streamId);
    this._emit('close', ev);
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────

/**
 * Open a WebSocket on the daemon at the given path, tunneled over
 * the WebRTC DC's `ws_proxy` channel.
 *
 * If the DC isn't open yet, the returned handle is already in
 * `connecting` state and will fail with a synthetic `error` + `close`
 * on the next microtask, so call sites can install listeners
 * synchronously after this call without race-checking.
 */
export function openRobotWebSocket(
  path: string,
  opts: RobotWebSocketOptions = {},
): RobotWebSocket {
  ensureRegistrySubscribed();

  const streamId = nextStreamId();
  const ws = new RobotWebSocketImpl(path, streamId);
  streams.set(streamId, { stream: ws });

  const dc = getActiveDataChannel();
  if (!dc || dc.readyState !== 'open') {
    logger.warn('open.no_dc', {
      stream_id: streamId,
      path,
      dc_state: dc?.readyState ?? null,
    });
    // Defer to the next microtask so the caller has a chance to
    // attach listeners before we synthesise the failure.
    Promise.resolve().then(() =>
      ws._localFail('no active webrtc data channel'),
    );
    return ws;
  }

  // Inject trace-id like `webrtcClient.ts` does for HTTP requests.
  const trace = getTraceId();
  const headers = trace
    ? { 'X-Trace-Id': trace, ...(opts.headers ?? {}) }
    : opts.headers ?? null;

  const cmd = {
    type: 'ws_open' as const,
    stream_id: streamId,
    path,
    headers,
  };

  logger.info('open.send', { stream_id: streamId, path });

  try {
    dc.send(JSON.stringify(cmd));
  } catch (err) {
    logger.error('open.send_error', {
      stream_id: streamId,
      path,
      message: err instanceof Error ? err.message : String(err),
    });
    Promise.resolve().then(() =>
      ws._localFail(
        `dc.send failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    );
  }

  return ws;
}
