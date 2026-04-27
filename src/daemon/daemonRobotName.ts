/**
 * Thin IO layer for `GET /api/daemon/robot-name` and the matching POST.
 *
 * Built on top of `daemonFetch` so it works in the contexts where we
 * already know the robot's LAN IP - notably the WiFi onboarding flow,
 * where the WebRTC tunnel does not exist yet. The same daemon endpoints
 * are reachable through `RobotClient.fetch()` once a session is open;
 * the (future) Settings rename screen will plug into that layer with
 * the same payload shapes.
 *
 * Validation lives in `robotName.ts`: callers are expected to validate
 * before posting, but the daemon does its own check anyway and the
 * 422 reason is forwarded via `RobotNamePostError`.
 */

import { daemonFetch } from './daemonFetch';
import {
  formatRobotNameError,
  validateRobotName,
  type RobotNameValidation,
} from './robotName';

export interface RobotNameInfo {
  name: string;
  source: 'default' | 'persisted' | 'cli' | string;
}

export type RobotNamePostFailure =
  | { kind: 'validation-local'; reason: RobotNameValidation }
  | { kind: 'validation-server'; status: number; message: string }
  | { kind: 'transport'; message: string };

/**
 * Typed error thrown by `setRobotNameOverLan`. Use ``error.failure`` to
 * pattern-match on the failure mode. We extend ``Error`` so it plays
 * nicely with React error boundaries, devtools, and `formatError`
 * helpers throughout the app.
 */
export class RobotNameError extends Error {
  readonly failure: RobotNamePostFailure;
  constructor(failure: RobotNamePostFailure, message: string) {
    super(message);
    this.name = 'RobotNameError';
    this.failure = failure;
  }
}

/**
 * Read the current robot name and the source the daemon used to
 * resolve it. Returns ``null`` when the route is not reachable; the
 * caller decides whether to retry, fall back to a default, or surface
 * a UI error.
 *
 * Older daemon revisions (api_revision < 2) don't expose this route
 * and reply 404; we treat that as ``null`` so the caller can degrade
 * gracefully (e.g. show the default name as read-only).
 */
export async function getRobotNameOverLan(
  host: string,
  opts: { timeoutMs?: number } = {},
): Promise<RobotNameInfo | null> {
  try {
    const resp = await daemonFetch<RobotNameInfo>(host, '/api/daemon/robot-name', {
      timeoutMs: opts.timeoutMs ?? 5_000,
    });
    if (!resp.ok || !resp.data) return null;
    return resp.data;
  } catch {
    return null;
  }
}

/**
 * Persist a new robot name. The daemon trims, validates, writes
 * ``daemon.json``, re-emits ``setPeerStatus`` to central, and rebroadcasts
 * the mDNS record. We pre-validate locally so a typo round-trips at
 * UI speed instead of bouncing off the network.
 *
 * Resolves with the freshly-applied ``RobotNameInfo`` on success and
 * rejects with a ``RobotNamePostError`` on failure - never throws a raw
 * Error so the call site can react to each case separately.
 */
export async function setRobotNameOverLan(
  host: string,
  rawName: string,
  opts: { timeoutMs?: number } = {},
): Promise<RobotNameInfo> {
  const validation = validateRobotName(rawName);
  if (validation.kind !== 'ok') {
    throw new RobotNameError(
      { kind: 'validation-local', reason: validation },
      formatRobotNameError(validation) ?? 'Invalid robot name.',
    );
  }

  let resp;
  try {
    resp = await daemonFetch<unknown>(host, '/api/daemon/robot-name', {
      method: 'POST',
      body: { name: validation.trimmed },
      timeoutMs: opts.timeoutMs ?? 8_000,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new RobotNameError({ kind: 'transport', message }, message);
  }

  if (!resp.ok) {
    const message =
      extractDaemonError(resp.rawBody) ??
      `Daemon rejected the name (HTTP ${resp.status}).`;
    throw new RobotNameError(
      { kind: 'validation-server', status: resp.status, message },
      message,
    );
  }

  // The POST returns a full ``DaemonStatus`` (we declared the response
  // model that way server-side) but for the rename flow all we need is
  // the freshly-applied name and source, which we re-derive: the GET
  // route is the canonical way to read it back, so we re-issue it. This
  // also lets us update the source label from "default" to "persisted"
  // immediately after the user submits.
  const refreshed = await getRobotNameOverLan(host, { timeoutMs: 4_000 });
  if (refreshed) return refreshed;
  return { name: validation.trimmed, source: 'persisted' };
}

function extractDaemonError(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.detail === 'string') return parsed.detail;
    if (Array.isArray(parsed?.detail)) {
      const first = parsed.detail[0];
      if (typeof first?.msg === 'string') return first.msg;
    }
  } catch {
    // Not JSON; fall through to raw body.
  }
  return body.length <= 200 ? body : null;
}
