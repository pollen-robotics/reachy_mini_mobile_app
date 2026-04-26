/**
 * Public types of the unified RobotClient transport layer.
 *
 * RobotClient hides whether daemon API calls go over LAN HTTP (Tauri's
 * `daemon_fetch` shim, picked when the phone has line-of-sight to the
 * robot) or over a WebRTC DataChannel `http_proxy` command (when the
 * phone reaches the robot through HF central signaling). Call sites
 * use the same `client.fetch(path, opts)` shape regardless, so adding
 * a new daemon endpoint becomes a single edit instead of two.
 *
 * The shape mirrors `daemonFetch`'s response on purpose: existing call
 * sites only need a one-line swap to migrate.
 */
export interface RobotFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /**
   * JSON-serialisable payload. Forwarded verbatim by the LAN
   * transport, JSON-stringified into the `body` field of the
   * `http_proxy` command by the WebRTC transport. Pass a string
   * directly when the daemon endpoint expects a non-JSON body
   * (rare).
   */
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Per-call timeout. Both transports honour it: the LAN one cuts
   * the underlying fetch, the WebRTC one cancels the pending
   * `request_id` entry (the daemon-side aiohttp call independently
   * times out at `timeout_s` so we don't leak state on the robot).
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
 * regardless of whether we sit on the LAN or are tunnelled through
 * central signaling.
 */
export interface RobotClient {
  /**
   * Discriminator so logs / error toasts can identify the active
   * transport at a glance. Reads as `local-http` on LAN and
   * `webrtc-proxy` over remote signalling.
   */
  readonly transport: 'local-http' | 'webrtc-proxy';
  fetch<T = unknown>(
    path: string,
    opts?: RobotFetchOptions,
  ): Promise<RobotResponse<T>>;
}
