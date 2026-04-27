/**
 * Lazy zombie-relay heal trigger.
 *
 * The conversation engine talks to HF central as its WebRTC signaling
 * rendezvous. When the daemon's relay drifts into a "zombie" state
 * (relay says connected, central lists no robot), `startSession()`
 * stalls forever. This hook exposes the heal primitive without
 * running it on every panel mount: callers (peer id resolution,
 * engine watchdog, retry button) trigger it on demand, only when a
 * symptom suggests the relay is actually misbehaving.
 *
 * Why a hook
 * ──────────
 * The state we care about is just `healing` (so the UI can render a
 * spinner if the heal lands on the user-facing path) plus a
 * `triggerHeal` callback. Wrapping it as a hook keeps the imperative
 * heal call collocated with the React state it owns, and lets us
 * reuse the same state across multiple consumers (`ConversePanel`,
 * `RobotSessionScreen`) inside the same screen tree.
 *
 * Anti-features (intentional)
 * ───────────────────────────
 *   - No automatic probe. The pre-flight check used to live here; it
 *     blocked every panel mount on a 1-3s health probe even when the
 *     relay was perfectly healthy. Lazy is faster on the happy path,
 *     and slow paths (zombie or relay-disconnected) still recover
 *     within the engine's own watchdog budget.
 *   - No retry-on-failure loop. A heal that comes back non-healthy
 *     after the budget means central / daemon need a human - looping
 *     would just mask the issue.
 *   - Concurrent calls are coalesced: the second `triggerHeal` while
 *     a previous one is still in flight returns the same promise so
 *     two simultaneous symptoms (e.g. peer id null + watchdog trip)
 *     don't double-POST `/refresh-relay`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  autoHealRelay,
  checkDaemonHealth,
  type DaemonHealth,
} from './daemonHealthCheck';
import type { RobotClient } from '../robot-client/types';

/**
 * Outcome of a heal cycle.
 *
 *   - `noop`: initial probe came back healthy, we never POSTed
 *     `/refresh-relay`. Important for callers that want to react to
 *     an *actual* recovery (e.g. force a fresh engine remount): on
 *     a healthy daemon there is nothing that just changed, so a
 *     remount would be churn for nothing.
 *   - `healed`: the relay was unhealthy, we POSTed `/refresh-relay`,
 *     and after the poll budget the daemon ↔ central handshake is
 *     back to `healthy`. Callers should treat their cached engine /
 *     SSE state as stale and rebuild.
 *   - `failed`: a heal was attempted but the daemon is still not
 *     healthy at the end of the budget. Caller should surface a
 *     user-actionable message instead of looping the heal.
 *   - `unreachable`: no client available, transport down. Same as
 *     `failed` for caller intents but logged distinctly so we can
 *     tell network problems from server problems in the trace.
 */
export type HealOutcome = 'noop' | 'healed' | 'failed' | 'unreachable';

export interface HealResult {
  outcome: HealOutcome;
  /** Snapshot of daemon health at the end of the cycle. */
  health: DaemonHealth;
}

export interface UseDaemonRelayHealingResult {
  /** True while a heal attempt is in flight. */
  healing: boolean;
  /**
   * Latest health snapshot observed on this screen. Updated by both
   * `triggerHeal` and `probe`. Useful for surfacing
   * "restart daemon manually" when `refreshEndpointAvailable === false`.
   */
  lastHealth: DaemonHealth | null;
  /**
   * Probe + (conditional) heal sequence. Returns a `HealResult` so
   * callers can distinguish the no-op case (already healthy) from a
   * real recovery and avoid forcing a remount when nothing changed.
   * Coalesced: simultaneous callers receive the same in-flight
   * promise.
   */
  triggerHeal: () => Promise<HealResult>;
  /**
   * One-shot health probe without heal. Lets callers verify state
   * after a manual retry without paying the heal-poll cost.
   */
  probe: () => Promise<DaemonHealth>;
}

/**
 * @param client - active RobotClient. Pass `null` when the transport
 *   isn't ready yet; `triggerHeal` will resolve to an `unreachable`
 *   sentinel rather than queuing.
 */
export function useDaemonRelayHealing(
  client: RobotClient | null,
): UseDaemonRelayHealingResult {
  const [healing, setHealing] = useState(false);
  const [lastHealth, setLastHealth] = useState<DaemonHealth | null>(null);
  const inflightRef = useRef<Promise<HealResult> | null>(null);

  // Drop any cached "not started yet" state when the underlying client
  // changes (LAN ↔ WebRTC swap, daemon host change). The old health
  // snapshot is no longer relevant once the transport identity moved.
  useEffect(() => {
    inflightRef.current = null;
    setLastHealth(null);
    setHealing(false);
  }, [client]);

  const probe = useCallback(async (): Promise<DaemonHealth> => {
    if (!client) {
      const fallback: DaemonHealth = { status: 'unreachable' };
      setLastHealth(fallback);
      return fallback;
    }
    const health = await checkDaemonHealth(client);
    setLastHealth(health);
    return health;
  }, [client]);

  const triggerHeal = useCallback(async (): Promise<HealResult> => {
    if (!client) {
      const fallback: DaemonHealth = { status: 'unreachable' };
      setLastHealth(fallback);
      return { outcome: 'unreachable', health: fallback };
    }
    if (inflightRef.current) return inflightRef.current;

    setHealing(true);
    const job = (async (): Promise<HealResult> => {
      try {
        // Skip the heal POST if the daemon is already happy: a quick
        // probe round-trips faster than the heal endpoint and saves
        // central an unnecessary SSE bounce. The `noop` outcome is the
        // signal callers use to NOT force a remount - the lazy-heal
        // path frequently lands here on cold-start happy paths (the
        // engine just needed another few seconds), and remounting
        // every time would loop the engine forever.
        const initial = await checkDaemonHealth(client);
        if (initial.status === 'healthy') {
          setLastHealth(initial);
          return { outcome: 'noop', health: initial };
        }
        const healed = await autoHealRelay(client);
        setLastHealth(healed);
        return {
          outcome: healed.status === 'healthy' ? 'healed' : 'failed',
          health: healed,
        };
      } finally {
        setHealing(false);
        inflightRef.current = null;
      }
    })();
    inflightRef.current = job;
    return job;
  }, [client]);

  return { healing, lastHealth, triggerHeal, probe };
}
