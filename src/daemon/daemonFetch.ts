import { invoke } from '@tauri-apps/api/core';

import { CONFIG } from '../config';

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
  const raw = await invoke<DaemonResponseRaw>('daemon_fetch', {
    req: {
      host,
      path,
      method: opts.method ?? 'GET',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
      headers: opts.headers ?? null,
      timeout_ms: opts.timeoutMs ?? CONFIG.DAEMON_TIMEOUT_MS,
    },
  });

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
