/**
 * Resolve the peer id the daemon is registered as on Hugging Face
 * central, so the conversation engine can call `startSession(id)`
 * directly instead of waiting for the SSE `robotsChanged` event.
 *
 * Why a hook instead of a one-shot fetch
 * ──────────────────────────────────────
 * The mobile app has a single unified transport (`RobotClient`):
 * every daemon HTTP call rides the WebRTC `http_proxy` command on
 * the SDK's DataChannel, regardless of whether discovery happened
 * over BLE or over Hugging Face central. ICE handles the LAN-vs-
 * relay routing transparently underneath.
 *
 * Taking a `RobotClient` (instead of plumbing a `daemonHost` or
 * forking on a `remoteMode` flag) keeps the call site uniform.
 * When the parent already knows the peer id (e.g. it just picked
 * the robot from the central card list), it passes `overridePeerId`
 * and the hook short-circuits the probe.
 *
 * Output contract
 * ───────────────
 *   - `peerId`     null if central hasn't acknowledged the robot yet
 *                  (zombie relay, no HF token, etc.); a non-empty
 *                  string when central lists at least one robot for
 *                  the authenticated user.
 *   - `resolved`   flips to `true` after the first probe has settled
 *                  (success OR failure). Callers gate engine mount on
 *                  this so we never read stale `null` as "no peer".
 *   - `refresh()`  re-runs the probe. Call after `autoHealRelay()` so
 *                  a previously-empty list gets re-checked once the
 *                  relay has reconnected.
 *
 * Failure handling: never throws. Every error path collapses to
 * `peerId: null, resolved: true` with a console warning, on the
 * grounds that a missing peer id is a soft fallback (engine drops
 * back to the public Space's robotsChanged flow) - we don't want a
 * single 5xx to wedge the entire conversation panel.
 *
 * Multi-robot caveat: the user might own several Reachy Minis on
 * the same HF account, but the mobile app is paired to one at a
 * time, so `robots[0]` is an imperfect heuristic. It's safe in
 * practice because each daemon only answers for its own central
 * registration, and the response is scoped to the authenticated
 * user - we cannot accidentally hand the engine a peer id that
 * belongs to a different robot than the one we're talking to.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '../logger';
import type { RobotClient } from '../robot-client/types';

const logger = createLogger('robot.peerId');

interface CentralRobotEntry {
  // Central's wire format is a bit loose - we've seen `id`, `peerId`
  // and `peer_id` in different versions of the relay, so we read
  // whatever's there rather than locking in one schema.
  id?: string;
  peerId?: string;
  peer_id?: string;
  meta?: { name?: string };
  name?: string;
}

interface CentralRobotStatusPayload {
  available: boolean;
  robots?: CentralRobotEntry[];
  reason?: string;
}

function extractId(entry: CentralRobotEntry | undefined): string | null {
  if (!entry) return null;
  const raw = entry.id ?? entry.peerId ?? entry.peer_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export interface UseRobotPeerIdResult {
  /** First entry of central's robot list, or null if none available. */
  peerId: string | null;
  /** True once the initial probe has finished (success or failure). */
  resolved: boolean;
  /** Re-run the probe. Useful after a relay heal. */
  refresh: () => Promise<void>;
}

/**
 * @param client - active RobotClient. Pass `null` while the transport
 *   is still being negotiated; the hook will idle and resolve as soon
 *   as a non-null client arrives.
 * @param overridePeerId - if provided, short-circuits the probe and
 *   returns this value immediately. Used by remote mode where the
 *   peer id was already validated when the user picked the robot
 *   from the central listing on the discovery screen.
 */
export function useRobotPeerId(
  client: RobotClient | null,
  overridePeerId?: string | null,
): UseRobotPeerIdResult {
  const [peerId, setPeerId] = useState<string | null>(overridePeerId ?? null);
  const [resolved, setResolved] = useState<boolean>(
    overridePeerId !== undefined,
  );

  // Cancellation flag for the in-flight probe. Used to make `refresh()`
  // safe to call concurrently and to guarantee the cleanup of an
  // unmounted component never lands a setState on a dead ref.
  const cancelTokenRef = useRef<{ cancelled: boolean } | null>(null);

  const runProbe = useCallback(
    async (activeClient: RobotClient): Promise<void> => {
      const token = { cancelled: false };
      if (cancelTokenRef.current) {
        cancelTokenRef.current.cancelled = true;
      }
      cancelTokenRef.current = token;
      try {
        const resp = await activeClient.fetch<CentralRobotStatusPayload>(
          '/api/hf-auth/central-robot-status',
          { timeoutMs: 5_000 },
        );
        if (token.cancelled) return;

        if (!resp.ok) {
          logger.warn('probe.http_error', {
            status: resp.status,
            body: resp.rawBody?.slice(0, 200),
          });
          setPeerId(null);
          setResolved(true);
          return;
        }

        const data = resp.data;
        if (!data?.available) {
          logger.info('probe.unavailable', { reason: data?.reason ?? 'unknown' });
          setPeerId(null);
          setResolved(true);
          return;
        }

        const robots = Array.isArray(data.robots) ? data.robots : [];
        if (!robots.length) {
          logger.info('probe.empty');
          setPeerId(null);
          setResolved(true);
          return;
        }

        const id = extractId(robots[0]);
        if (!id) {
          logger.warn('probe.no_id_field', { first: robots[0] });
          setPeerId(null);
          setResolved(true);
          return;
        }

        logger.info('probe.ok', { peer_id: id });
        setPeerId(id);
        setResolved(true);
      } catch (err) {
        if (token.cancelled) return;
        logger.warn('probe.error', {
          message: err instanceof Error ? err.message : String(err),
        });
        setPeerId(null);
        setResolved(true);
      }
    },
    [],
  );

  useEffect(() => {
    // Override path: caller already knows the peer id (typically the
    // remote-discovery flow where it came from central's robot list
    // straight to the discovery screen). Skip the probe entirely.
    if (overridePeerId !== undefined) {
      setPeerId(overridePeerId);
      setResolved(true);
      return;
    }
    if (!client) {
      setResolved(false);
      setPeerId(null);
      return;
    }
    void runProbe(client);
    return () => {
      const token = cancelTokenRef.current;
      if (token) token.cancelled = true;
    };
  }, [client, overridePeerId, runProbe]);

  const refresh = useCallback(async (): Promise<void> => {
    if (overridePeerId !== undefined) return;
    if (!client) return;
    await runProbe(client);
  }, [client, overridePeerId, runProbe]);

  return { peerId, resolved, refresh };
}
