/**
 * Public types of the unified RobotClient transport layer.
 *
 * Every `client.fetch(path, opts)` call ends up as an `http_proxy`
 * command sent on the WebRTC DataChannel hosted by the conversation
 * engine. The daemon's `_async_http_proxy` handler bridges it onto its
 * own loopback HTTP server and replies with `http_proxy_response`,
 * carrying the same `request_id` for correlation. The phone never
 * opens a direct TCP socket to the daemon - ICE figures out whether
 * the underlying WebRTC PeerConnection is a LAN host candidate or a
 * TURN-relayed remote tunnel, and we get "prefer LAN when reachable"
 * for free without dual code paths.
 *
 * The shape mirrors `daemonFetch`'s response on purpose: existing call
 * sites only need a one-line swap from `daemonFetch(host, path, opts)`
 * to `client.fetch(path, opts)` to migrate.
 */
export interface RobotFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /**
   * JSON-serialisable payload, JSON-stringified into the `body` field
   * of the `http_proxy` command. Pass a string directly when the
   * daemon endpoint expects a non-JSON body (rare).
   */
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Per-call timeout. The transport cancels the pending `request_id`
   * entry on expiry, and the daemon-side aiohttp call independently
   * times out at `timeout_s` so we don't leak state on the robot.
   */
  timeoutMs?: number;
}

/**
 * Normalised response. `data` is the parsed JSON when the daemon
 * returned `application/json`, `null` otherwise. `rawBody` is always
 * a string so callers can inspect HTML / plain-text payloads (e.g.
 * 404 stack traces) without crashing on `JSON.parse`.
 */
export interface RobotResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T | null;
  rawBody: string;
}

// ─── WebSocket proxy ───────────────────────────────────────────────

/**
 * Reachable readyStates on a `RobotWebSocket`. Same names as the
 * native `WebSocket` constants so call sites that already know the
 * latter don't have to learn a second vocabulary, but exposed as a
 * string union (cheaper than carrying numeric constants through the
 * proxy wire format).
 */
export type RobotWebSocketReadyState =
  | 'connecting'
  | 'open'
  | 'closing'
  | 'closed';

export interface RobotWebSocketCloseEvent {
  /**
   * 1000 for clean server-side close, 1006 for abnormal close
   * (DataChannel down or daemon error before handshake), or whatever
   * the daemon-side aiohttp WS reports.
   */
  code: number;
  reason: string;
  /** True iff the peer (daemon) initiated the close. */
  wasClean: boolean;
}

export interface RobotWebSocketMessageEvent {
  /** TEXT-only today. Binary frames are dropped server-side. */
  data: string;
}

export interface RobotWebSocketErrorEvent {
  /** Free-form, human-readable error string. */
  error: string;
}

export interface RobotWebSocketEventMap {
  open: void;
  message: RobotWebSocketMessageEvent;
  close: RobotWebSocketCloseEvent;
  error: RobotWebSocketErrorEvent;
}

export interface RobotWebSocketOptions {
  /**
   * Headers to forward on the daemon-side `ws_connect`. Hop-by-hop
   * and handshake-owned headers (`Host`, `Upgrade`, `Sec-WebSocket-*`,
   * etc.) are dropped server-side, so passing them is harmless.
   * Trace-id is injected automatically when set on the logger.
   */
  headers?: Record<string, string>;
}

/**
 * WebSocket-shaped handle multiplexed over the WebRTC DC's `ws_proxy`
 * channel. Single-server-frame payloads always arrive as strings.
 *
 * Lifecycle states:
 *
 *     connecting → open  → closing → closed   (clean close)
 *     connecting → closed                     (handshake refused)
 *     open       → closed                     (DC torn down or daemon
 *                                              dropped the WS without
 *                                              going through close())
 *
 * Listeners are invoked synchronously from the DC dispatcher: never
 * throw from them, return early instead. Removing a listener mid-
 * dispatch is safe (the dispatcher iterates over a snapshot).
 */
export interface RobotWebSocket {
  readonly readyState: RobotWebSocketReadyState;
  /** Path the WS was opened on, kept for log correlation. */
  readonly path: string;
  /**
   * Send a TEXT frame. No-op when not in `open` state (matches native
   * `WebSocket` "InvalidStateError" semantics but without throwing,
   * because every call site in this app would just have to wrap it
   * in a try/catch otherwise).
   */
  send(data: string): void;
  /**
   * Initiate a clean close. The daemon will tear down the upstream
   * WS, send a final `ws_closed`, and the local handle transitions
   * to `closed`. Idempotent.
   */
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof RobotWebSocketEventMap>(
    type: K,
    listener: (ev: RobotWebSocketEventMap[K]) => void,
  ): void;
  removeEventListener<K extends keyof RobotWebSocketEventMap>(
    type: K,
    listener: (ev: RobotWebSocketEventMap[K]) => void,
  ): void;
}

/**
 * Transport-tagged client. Fetch any /api/... path on the daemon
 * through the WebRTC `http_proxy` tunnel, regardless of whether the
 * underlying PeerConnection ended up as a LAN host candidate or a
 * TURN-relayed remote one.
 */
export interface RobotClient {
  /**
   * Discriminator kept for log readability and forward-compat. Today
   * always reads as `webrtc-proxy`; we keep the union form so adding
   * a future transport (e.g. native HTTP/3 once mobile webviews
   * support it cleanly) is a single-line change instead of a sweep.
   */
  readonly transport: 'webrtc-proxy';
  fetch<T = unknown>(
    path: string,
    opts?: RobotFetchOptions,
  ): Promise<RobotResponse<T>>;
  /**
   * Open a `ws_proxy` stream on top of the same WebRTC DC. The
   * daemon-side handler bridges the call to `ws://localhost{path}`,
   * so any WebSocket route exposed by the FastAPI app is reachable.
   *
   * Calls made before the DC is open return a handle that's already
   * `closed` and emits a synthetic `error` + `close` on the next
   * microtask, so React effects can install listeners synchronously
   * without race-checking the DC state.
   */
  openWs(path: string, opts?: RobotWebSocketOptions): RobotWebSocket;
}
