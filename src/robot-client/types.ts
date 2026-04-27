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
}
