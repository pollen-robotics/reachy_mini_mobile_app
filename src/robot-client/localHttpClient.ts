/**
 * LAN transport for `RobotClient`.
 *
 * Thin wrapper over `daemonFetch` (which itself wraps Tauri's
 * `daemon_fetch` Rust command). We keep `daemonFetch` as the single
 * source of truth for HTTP plumbing (timeouts, JSON parsing, header
 * shape) and only re-shape the result into the `RobotResponse`
 * envelope so call sites see the same type whatever the transport.
 */
import { daemonFetch } from '../daemon/daemonFetch';

import type { RobotClient, RobotFetchOptions, RobotResponse } from './types';

export function createLocalHttpClient(host: string): RobotClient {
  return {
    transport: 'local-http',
    async fetch<T = unknown>(
      path: string,
      opts: RobotFetchOptions = {},
    ): Promise<RobotResponse<T>> {
      const resp = await daemonFetch<T>(host, path, {
        method: opts.method,
        body: opts.body,
        headers: opts.headers,
        timeoutMs: opts.timeoutMs,
      });
      return {
        status: resp.status,
        ok: resp.ok,
        data: resp.data,
        rawBody: resp.rawBody,
      };
    },
  };
}
