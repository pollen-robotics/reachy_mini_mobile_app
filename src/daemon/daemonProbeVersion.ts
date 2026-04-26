/**
 * Daemon version probe.
 *
 * The mobile app evolves faster than the daemon shipped on each
 * physical robot. When a new endpoint lands here (e.g. PR-F's
 * "Forget Wi-Fi via HTTP", or a future `/api/wifi/forget` shape
 * change) and the user's robot is on an older daemon, the call
 * silently 404s and the UI feature looks broken.
 *
 * Solution: probe `/api/daemon/version` once during the connection
 * handshake, compare against `MIN_SUPPORTED_DAEMON_API_REVISION`,
 * and surface a non-blocking warning banner when the daemon is too
 * old. We deliberately do *not* gate the session: most features
 * still work, and forcing the user to update their robot mid-call
 * is hostile.
 *
 * Probe contract
 * ──────────────
 *   GET /api/daemon/version
 *   → { version: "0.7.3", api_revision: "1" }
 *
 * `api_revision` is a daemon-controlled monotonic marker that the
 * daemon bumps whenever its HTTP surface changes in a way that
 * matters for clients. Pip versions are unreliable for feature
 * gating (a 0.x → 1.x bump may not change the API at all), so we
 * lean on `api_revision` as the authoritative compatibility check.
 *
 * Older daemons (pre-PR-1052) don't have this endpoint at all and
 * return 404. We treat that as "api_revision < 1" so the warning
 * banner triggers without exception.
 */
import type { RobotClient } from '../robot-client';

import { createLogger } from '../logger';

const logger = createLogger('daemon.version');

/**
 * Bump this when the mobile app starts depending on a new daemon
 * endpoint or shape. Daemons advertising a strictly lower
 * `api_revision` will trigger the "outdated daemon" warning.
 */
export const MIN_SUPPORTED_DAEMON_API_REVISION = 1;

interface VersionPayload {
  version?: string;
  api_revision?: string | number;
}

export interface DaemonVersionInfo {
  version: string | null;
  apiRevision: number | null;
  outdated: boolean;
  /** Set when the probe failed entirely (network error, daemon down). */
  unreachable: boolean;
}

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/**
 * Hit `/api/daemon/version` and synthesise a `DaemonVersionInfo`. The
 * call is deliberately tolerant: any non-200 short of a network
 * timeout is treated as "old daemon, no version field" rather than a
 * fatal failure. The session can still proceed.
 */
export async function probeDaemonVersion(
  client: RobotClient,
): Promise<DaemonVersionInfo> {
  const t0 = performance.now();
  try {
    const resp = await client.fetch<VersionPayload>('/api/daemon/version', {
      method: 'GET',
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    });
    const latencyMs = Math.round(performance.now() - t0);

    if (resp.status === 404) {
      // Daemon predates PR-1052. Treat as "ancient" to fire the banner.
      logger.warn('probe.endpoint_missing', { latency_ms: latencyMs });
      return {
        version: null,
        apiRevision: 0,
        outdated: true,
        unreachable: false,
      };
    }
    if (!resp.ok || !resp.data) {
      logger.warn('probe.bad_response', {
        status: resp.status,
        latency_ms: latencyMs,
      });
      return {
        version: null,
        apiRevision: null,
        outdated: false,
        unreachable: false,
      };
    }

    const apiRevisionRaw = resp.data.api_revision;
    const apiRevision =
      apiRevisionRaw === undefined
        ? null
        : Number(apiRevisionRaw);
    const versionStr = resp.data.version ?? null;
    const outdated =
      apiRevision !== null &&
      Number.isFinite(apiRevision) &&
      apiRevision < MIN_SUPPORTED_DAEMON_API_REVISION;

    logger.info('probe.ok', {
      version: versionStr,
      api_revision: apiRevision,
      outdated,
      latency_ms: latencyMs,
    });

    return {
      version: versionStr,
      apiRevision: apiRevision !== null && Number.isFinite(apiRevision) ? apiRevision : null,
      outdated,
      unreachable: false,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    logger.warn('probe.unreachable', {
      latency_ms: latencyMs,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      version: null,
      apiRevision: null,
      outdated: false,
      unreachable: true,
    };
  }
}
