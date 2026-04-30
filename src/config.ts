/**
 * App-wide configuration constants.
 *
 * Keeping magic strings out of feature modules so design decisions stay
 * discoverable (grep for `CONFIG` and you get the full story).
 */

export const CONFIG = {
  /** Daemon HTTP port exposed by the reachy-mini Python daemon. */
  DAEMON_PORT: 8000,

  /**
   * HuggingFace Space that hosts the conversation UI.
   *
   * We point at the *direct* Space domain (`*.hf.space`), not the wrapper
   * page on `huggingface.co/spaces/...`. The wrapper ships an
   * `X-Frame-Options: DENY` header and cannot be iframed; the direct
   * domain can. The Space is still served over HTTPS, which keeps the
   * iframe in a secure context and allows microphone access.
   *
   * Naming rule: `https://{namespace}-{repo}.hf.space`, slashes replaced
   * by dashes, lowercased (Space identifiers are case-insensitive).
   */
  CONVERSATION_URL: 'https://tfrere-reachy-mini-minimal-js-conversation-app.hf.space',

  /**
   * Hugging Face central signaling server. Used for the remote robot
   * listing (`/api/robot-status`), the WebRTC signaling envelope POSTs
   * (`/send`) and the SDK's WebRTC handshake (passed as `signalingUrl`).
   *
   * Override via `VITE_REACHY_CENTRAL_URL` at build time to point at a
   * fork (test Space, staging, etc.). The default points at the
   * `tfrere` instance, which must match the daemon's
   * `REACHY_CENTRAL_URL` env or both sides query different stores and
   * the app will not see any robot the daemon registered.
   */
  CENTRAL_URL:
    (import.meta.env.VITE_REACHY_CENTRAL_URL as string | undefined) ||
    'https://tfrere-reachy-mini-central.hf.space',

  /**
   * mDNS service advertised by the daemon
   * (`reachy_mini/utils/discovery.py::SERVICE_TYPE`).
   * Kept here for cross-reference; the browse call itself lives in
   * `src-tauri/src/discovery.rs`.
   */
  MDNS_SERVICE: '_reachy-mini._tcp.local.',

  /**
   * Default REST timeout for daemon calls, milliseconds.
   *
   * Daemon status calls are lightweight; anything longer than 5 s usually
   * means the robot is not reachable at all.
   */
  DAEMON_TIMEOUT_MS: 5_000,
} as const;

/** Supported daemon versions (informational for now, enforced later). */
export const SUPPORTED_DAEMON_VERSION = '1.7.0';
