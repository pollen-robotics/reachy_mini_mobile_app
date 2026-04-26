import { invoke } from '@tauri-apps/api/core';

import { CONFIG } from '../config';
import { createLogger, getTraceId } from '../logger';

const logger = createLogger('daemon.http');

/**
 * Response shape returned by the Rust `daemon_fetch` command.
 * Matches `commands::DaemonResponse` on the Rust side.
 */
interface DaemonResponseRaw {
  status: number;
  ok: boolean;
  body: string;
}

export interface DaemonFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. Defaults to `CONFIG.DAEMON_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface DaemonResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T | null;
  /** Present when `data` is not valid JSON (or the response body was empty). */
  rawBody: string;
}

/**
 * Call the Reachy Mini daemon over HTTP through the Rust proxy.
 *
 * Why not `fetch()` directly? Mobile WebViews block plain-HTTP calls from
 * our HTTPS-origin frontend (mixed content). `tauri::command daemon_fetch`
 * runs on native Rust and has no such restriction.
 *
 * @param host - Robot hostname or IP (no scheme, no port).
 * @param path - Endpoint path starting with `/`, e.g. `/api/daemon/status`.
 * @param opts - Optional method / body / headers / timeout.
 */
export async function daemonFetch<T = unknown>(
  host: string,
  path: string,
  opts: DaemonFetchOptions = {}
): Promise<DaemonResponse<T>> {
  // Inject the active trace-id as a request header so daemon-side logs
  // (PR-B) can correlate. Caller-supplied headers win, so an explicit
  // override is always respected.
  const trace = getTraceId();
  const headers = trace
    ? { 'X-Trace-Id': trace, ...(opts.headers ?? {}) }
    : opts.headers ?? null;

  const method = opts.method ?? 'GET';
  const t0 = performance.now();
  logger.debug('request', { method, host, path });

  const raw = await invoke<DaemonResponseRaw>('daemon_fetch', {
    req: {
      host,
      path,
      method,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
      headers,
      timeout_ms: opts.timeoutMs ?? CONFIG.DAEMON_TIMEOUT_MS,
    },
  });

  const latencyMs = Math.round(performance.now() - t0);
  // Successes at DEBUG, failures at WARN. Everyone wants 4xx/5xx surfaced.
  if (raw.ok) {
    logger.debug('response', { method, path, status: raw.status, latency_ms: latencyMs });
  } else {
    logger.warn('response', { method, path, status: raw.status, latency_ms: latencyMs });
  }

  let data: T | null = null;
  if (raw.body.length > 0) {
    try {
      data = JSON.parse(raw.body) as T;
    } catch {
      // Response body was not JSON - keep `data` null, caller can read `rawBody`.
    }
  }

  return { status: raw.status, ok: raw.ok, data, rawBody: raw.body };
}
