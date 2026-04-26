/**
 * Remote transport for `RobotClient`.
 *
 * Sends `http_proxy` commands on the WebRTC DataChannel that the
 * Reachy SDK has already opened with the daemon. The daemon's
 * `_async_http_proxy` handler (see `reachy_mini.daemon.backend
 * .abstract.AbstractBackend`) forwards the call to its own
 * loopback HTTP server and replies with `http_proxy_response`,
 * carrying the same `request_id` for correlation.
 *
 * Why piggyback on the SDK's DC instead of opening our own?
 * ─────────────────────────────────────────────────────────
 * RTCDataChannels are negotiated in the SDP. Adding one after the
 * fact requires renegotiation, which the GStreamer producer on the
 * robot doesn't trigger for late-joining application channels. The
 * SDK's existing channel happily accepts arbitrary JSON (the daemon
 * dispatcher pydantic-validates each message; only `http_proxy`
 * payloads hit our new branch), so we just share it.
 *
 * Concurrency model
 * ─────────────────
 *   - Each `fetch()` allocates a fresh UUID `request_id` and
 *     registers itself in `pending` before sending.
 *   - A single DC `message` listener (installed on the *active*
 *     channel via the registry, re-attached on every replacement)
 *     looks up the entry by `request_id` and resolves the promise.
 *   - Per-call timeout cancels the pending entry and resolves with
 *     a `status: 0` synthetic response, mirroring `daemonFetch`'s
 *     behaviour for transport failures so call sites have one
 *     error path instead of two.
 *
 * The listener never `preventDefault`s or swallows messages it
 * doesn't recognise: the SDK's own typed-command responses keep
 * flowing to its onmessage handler unchanged.
 */
import { createLogger, getTraceId } from '../logger';
import {
  getActiveDataChannel,
  subscribeDataChannel,
} from './dataChannelRegistry';
import type { RobotClient, RobotFetchOptions, RobotResponse } from './types';

const logger = createLogger('webrtc.proxy');

/** Daemon → mobile reply shape (mirrors `_async_http_proxy`). */
interface ProxyResponseMsg {
  type: 'http_proxy_response';
  request_id: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
  error?: string | null;
}

interface PendingEntry {
  resolve: (resp: RobotResponse<unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

/**
 * Track which channel we are currently subscribed to so we attach the
 * `message` listener exactly once per DC instance even if multiple
 * `WebRtcRobotClient`s are alive at the same time.
 */
let attachedChannel: RTCDataChannel | null = null;
let registrySubscribed = false;

function attachToChannel(dc: RTCDataChannel | null): void {
  if (dc === attachedChannel) return;
  attachedChannel = dc;
  if (!dc) return;
  dc.addEventListener('message', handleDataChannelMessage);
  dc.addEventListener('close', () => {
    if (attachedChannel === dc) attachedChannel = null;
    failAllPending('webrtc data channel closed');
  });
}

function ensureRegistrySubscribed(): void {
  if (registrySubscribed) return;
  registrySubscribed = true;
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
    (parsed as { type?: unknown }).type !== 'http_proxy_response'
  ) {
    return;
  }
  const msg = parsed as ProxyResponseMsg;
  const entry = pending.get(msg.request_id);
  if (!entry) {
    // Either we already timed out client-side or the daemon echoed a
    // response we don't expect. Logged at debug because it's noisy
    // when a request is cancelled mid-flight.
    console.debug('[robot-client] orphan http_proxy_response', {
      requestId: msg.request_id,
      status: msg.status,
    });
    return;
  }
  pending.delete(msg.request_id);
  clearTimeout(entry.timer);

  // Normalise the daemon reply into the unified `RobotResponse`:
  // `data` carries the parsed JSON when present, `rawBody` carries a
  // string we can show in error UIs even when the daemon answered
  // non-JSON (e.g. a 404 default page).
  const bodyField = msg.body;
  let rawBody: string;
  if (typeof bodyField === 'string') {
    rawBody = bodyField;
  } else if (bodyField == null) {
    rawBody = '';
  } else {
    try {
      rawBody = JSON.stringify(bodyField);
    } catch {
      rawBody = '';
    }
  }
  entry.resolve({
    status: msg.status,
    ok: msg.status >= 200 && msg.status < 300,
    data: bodyField as unknown,
    rawBody,
  });
}

function failAllPending(reason: string): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.resolve({
      status: 0,
      ok: false,
      data: null,
      rawBody: reason,
    });
  }
  pending.clear();
}

function nextRequestId(): string {
  // crypto.randomUUID is available in every WebView we ship to (iOS
  // 16+, Android Tauri, modern desktop). Fall back to a timestamp +
  // random suffix if the runtime is older than expected so we don't
  // crash on bootstrap.
  const c = (
    globalThis as unknown as {
      crypto?: { randomUUID?: () => string };
    }
  ).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface WebRtcClientOptions {
  /** Fallback timeout when the caller didn't pass one. */
  defaultTimeoutMs?: number;
}

export function createWebRtcClient(
  opts: WebRtcClientOptions = {},
): RobotClient {
  ensureRegistrySubscribed();
  const defaultTimeout = opts.defaultTimeoutMs ?? 30_000;

  return {
    transport: 'webrtc-proxy',
    async fetch<T = unknown>(
      path: string,
      fopts: RobotFetchOptions = {},
    ): Promise<RobotResponse<T>> {
      const dc = getActiveDataChannel();
      if (!dc || dc.readyState !== 'open') {
        return {
          status: 0,
          ok: false,
          data: null,
          rawBody: 'no active webrtc data channel',
        };
      }

      const requestId = nextRequestId();
      const timeoutMs = fopts.timeoutMs ?? defaultTimeout;
      // The daemon honours `timeout_s` on its end too; we shave the
      // client window down by ~10 % so a slow LAN doesn't have us
      // give up before the daemon's own retry/abort.
      const daemonTimeoutS = Math.max(0.5, Math.min(300, (timeoutMs / 1000) * 0.9));

      // Inject the active trace-id into the proxied headers so daemon
      // logs (PR-B) can correlate with mobile-side ones. Caller-set
      // headers win, mirroring `daemonFetch`.
      const trace = getTraceId();
      const headers = trace
        ? { 'X-Trace-Id': trace, ...(fopts.headers ?? {}) }
        : fopts.headers ?? null;

      const cmd = {
        type: 'http_proxy' as const,
        request_id: requestId,
        method: fopts.method ?? 'GET',
        path,
        body: fopts.body !== undefined ? fopts.body : null,
        headers,
        timeout_s: daemonTimeoutS,
      };

      const t0 = performance.now();
      logger.debug('request', { method: cmd.method, path });

      return new Promise<RobotResponse<T>>(resolve => {
        const timer = setTimeout(() => {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          logger.warn('timeout', { method: cmd.method, path, timeout_ms: timeoutMs });
          resolve({
            status: 0,
            ok: false,
            data: null,
            rawBody: `webrtc proxy timeout after ${timeoutMs}ms`,
          });
        }, timeoutMs);

        pending.set(requestId, {
          resolve: r => {
            const latencyMs = Math.round(performance.now() - t0);
            const typed = r as RobotResponse<unknown>;
            if (typed.ok) {
              logger.debug('response', {
                method: cmd.method,
                path,
                status: typed.status,
                latency_ms: latencyMs,
              });
            } else {
              logger.warn('response', {
                method: cmd.method,
                path,
                status: typed.status,
                latency_ms: latencyMs,
              });
            }
            resolve(r as RobotResponse<T>);
          },
          timer,
        });

        try {
          dc.send(JSON.stringify(cmd));
        } catch (err) {
          pending.delete(requestId);
          clearTimeout(timer);
          logger.error('send.error', {
            method: cmd.method,
            path,
            message: err instanceof Error ? err.message : String(err),
          });
          resolve({
            status: 0,
            ok: false,
            data: null,
            rawBody: `dc.send failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      });
    },
  };
}
