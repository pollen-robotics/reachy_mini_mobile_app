/**
 * Cross-check the daemon's view of itself (`/relay-status`) against what
 * HF central actually sees (`/central-robot-status`), and surface any
 * split-brain state before the conversation engine starts its own
 * WebRTC handshake.
 *
 * Why this lives at all
 * ─────────────────────
 * In production we have seen this exact desync (called "zombie relay"
 * in the rest of the code):
 *
 *   GET /api/hf-auth/relay-status          → { is_connected: true }
 *   GET /api/hf-auth/central-robot-status  → { available: true, robots: [] }
 *
 * The relay still holds an SSE channel open with central, but central
 * no longer lists this robot as a producer for the authenticated user.
 * Any WebRTC client that tries to call this robot then stalls at
 * "Waiting for Reachy" until someone SSHes in and restarts the daemon.
 *
 * Causes we've observed:
 *   - HF token rotated on the account; the relay kept using the old one.
 *   - Transient error during `setPeerStatus` on central that the relay
 *     swallowed without tearing down its SSE.
 *   - Daemon started before any HF token was stored, never retried
 *     registration after login.
 *
 * The mobile app is uniquely placed to detect this: it's the one
 * issuing `startSession` and therefore the one that pays the "waiting
 * forever" price. So we do a cheap pre-flight here, and - if the daemon
 * ships the new `/refresh-relay` endpoint - we auto-heal without ever
 * bothering the user.
 *
 * Intentional non-goals
 * ─────────────────────
 *   - We don't try to cover every "central is temporarily sad" case.
 *     The engine's own 15s timeout catches those. We only care about
 *     the *persistent* zombie state that never recovers on its own.
 *   - We don't mutate daemon state beyond a single POST to the heal
 *     endpoint. No retries, no loops - if auto-heal doesn't fix the
 *     desync in one shot, something is wrong that needs a human.
 */
import { daemonFetch } from './daemonFetch';

/**
 * Summary of the daemon ↔ central handshake health.
 *
 *   healthy             Relay is connected and central lists this robot.
 *                       Engine can start immediately.
 *   zombie-relay        Relay says connected, central says robots: [].
 *                       Needs `/refresh-relay` or a daemon restart.
 *   relay-disconnected  Relay explicitly not connected. The daemon will
 *                       self-reconnect soon; caller can either wait or
 *                       surface a transient warning.
 *   no-token            Daemon has no HF token stored. User must sign in
 *                       (upstream flow; nothing for us to heal).
 *   unreachable         We couldn't even reach the daemon endpoints.
 *                       Likely network or daemon crash.
 */
export type DaemonHealthStatus =
  | 'healthy'
  | 'zombie-relay'
  | 'relay-disconnected'
  | 'no-token'
  | 'unreachable';

export interface DaemonHealth {
  status: DaemonHealthStatus;
  /** Raw relay state, useful for debug logs / future UI hints. */
  relayState?: string;
  /** Number of robots central reports for this account. 0 signals zombie. */
  centralRobotCount?: number;
  /**
   * True when the daemon exposes the `POST /api/hf-auth/refresh-relay`
   * endpoint we rely on to self-heal. When false, `autoHeal()` is a
   * no-op and we must tell the user to restart the daemon manually.
   */
  refreshEndpointAvailable?: boolean;
}

interface RelayStatusPayload {
  state?: string;
  is_connected?: boolean;
  message?: string;
}

interface CentralRobotStatusPayload {
  available: boolean;
  robots?: unknown[];
  reason?: string;
}

interface RefreshRelayPayload {
  status?: string;
  token_available?: boolean;
  reason?: string;
}

/**
 * Run both status checks in parallel and classify the result.
 *
 * Always resolves (never throws) - network errors degrade to
 * `unreachable` rather than propagating, because this function is
 * called on the happy path before every engine mount and we don't
 * want a single 5xx to block the UI entirely.
 */
export async function checkDaemonHealth(host: string): Promise<DaemonHealth> {
  try {
    // Parallel fetch: we want both readings synchronised, and neither
    // depends on the other's result.
    const [relayResp, centralResp] = await Promise.all([
      daemonFetch<RelayStatusPayload>(host, '/api/hf-auth/relay-status', {
        timeoutMs: 5_000,
      }),
      daemonFetch<CentralRobotStatusPayload>(
        host,
        '/api/hf-auth/central-robot-status',
        { timeoutMs: 5_000 }
      ),
    ]);

    if (!relayResp.ok || !centralResp.ok) {
      return {
        status: 'unreachable',
        relayState: relayResp.data?.state,
      };
    }

    const relayState = relayResp.data?.state;
    const relayConnected = relayResp.data?.is_connected === true;
    const central = centralResp.data;
    const robots = Array.isArray(central?.robots) ? central!.robots : [];

    // `available: false` with reason `not_authenticated` means the
    // daemon simply has no HF token. That's a user-level problem - the
    // mobile app's auth flow takes care of it; we don't try to heal.
    if (central && !central.available) {
      if (central.reason === 'not_authenticated') {
        return {
          status: 'no-token',
          relayState,
          centralRobotCount: 0,
        };
      }
      // Central reachable from us but unable to answer upstream. Could
      // be a transient central-side hiccup; treat like unreachable so
      // we don't try to heal something we don't understand.
      return {
        status: 'unreachable',
        relayState,
      };
    }

    if (!relayConnected) {
      return {
        status: 'relay-disconnected',
        relayState,
        centralRobotCount: robots.length,
      };
    }

    // The split-brain signature. Relay says connected, but central
    // doesn't list any robot for this account - our cue to self-heal.
    if (robots.length === 0) {
      return {
        status: 'zombie-relay',
        relayState,
        centralRobotCount: 0,
      };
    }

    return {
      status: 'healthy',
      relayState,
      centralRobotCount: robots.length,
    };
  } catch (err) {
    console.warn('[daemonHealth] check failed:', err);
    return { status: 'unreachable' };
  }
}

/**
 * Attempt to recover from a zombie-relay state by asking the daemon to
 * drop its current central SSE and re-register with the stored HF
 * token. Only meaningful when the previous `checkDaemonHealth` call
 * returned `'zombie-relay'`.
 *
 * Returns the health state the daemon is in AFTER the heal attempt,
 * polled up to `maxWaitMs` so the caller knows whether to proceed or
 * show an error.
 *
 *   - `healthy`             → heal worked, caller can mount the engine.
 *   - `zombie-relay`        → heal endpoint was accepted but central
 *                             still hasn't registered the robot within
 *                             the budget. Caller should surface a
 *                             "restart daemon on robot" hint.
 *   - any other status      → something else changed in the meantime;
 *                             caller decides what to do (usually retry
 *                             the mount).
 *
 * We intentionally don't set the `refreshEndpointAvailable` flag on
 * success (it's redundant once we've healed); we DO set it to `false`
 * when the endpoint returns 404, so callers can distinguish "daemon
 * too old to self-heal, user must restart it manually" from "heal
 * failed for some other reason".
 */
export async function autoHealRelay(
  host: string,
  // 15s covers the worst-case observed cycle on a freshly booted
  // daemon: SSE handshake to central (~1s), token validate (~2s),
  // setPeerStatus round-trip (~500ms), plus a safety margin for
  // flaky WiFi. Below 10s we regularly time out on a reconnect that
  // *would have* succeeded two seconds later.
  maxWaitMs: number = 15_000
): Promise<DaemonHealth> {
  try {
    const resp = await daemonFetch<RefreshRelayPayload>(
      host,
      '/api/hf-auth/refresh-relay',
      { method: 'POST', timeoutMs: 5_000 }
    );

    if (resp.status === 404) {
      // Daemon is from before the refresh-relay endpoint shipped. We
      // cannot heal programmatically; tell the caller.
      console.warn(
        '[daemonHealth] refresh-relay endpoint missing on daemon (HTTP 404)'
      );
      const latest = await checkDaemonHealth(host);
      return { ...latest, refreshEndpointAvailable: false };
    }

    if (!resp.ok) {
      console.warn(
        `[daemonHealth] refresh-relay failed: HTTP ${resp.status} ${resp.rawBody}`
      );
      return checkDaemonHealth(host);
    }

    // Endpoint accepted the request. The relay drops its SSE and
    // reconnects async; poll central-side every ~1s until it shows
    // the robot back, or we run out of budget.
    const deadline = Date.now() + maxWaitMs;
    let latest = await checkDaemonHealth(host);
    while (Date.now() < deadline && latest.status !== 'healthy') {
      // 1s cadence: fast enough to feel responsive in the UI, slow
      // enough that we don't DoS the daemon during the reconnect
      // storm (central's SSE handshake itself takes ~500ms).
      await new Promise((r) => setTimeout(r, 1_000));
      latest = await checkDaemonHealth(host);
    }
    return { ...latest, refreshEndpointAvailable: true };
  } catch (err) {
    console.warn('[daemonHealth] autoHeal failed:', err);
    return { status: 'unreachable' };
  }
}

/**
 * True when the health status means the engine can safely start a
 * WebRTC session. Factored out so call-sites stay declarative and
 * don't have to remember which subset of statuses is considered OK.
 */
export function isHealthyForMount(health: DaemonHealth): boolean {
  return health.status === 'healthy';
}
