/**
 * Resolve the Hugging Face central `peer_id` for whichever robot the
 * user is about to talk to.
 *
 * Why this hook exists
 * ────────────────────
 * The conversation engine needs a `peer_id` to call `startSession(id)`
 * synchronously - that's how it skips the slow SSE `robotsChanged`
 * wait that the public Space app has to do (see
 * `conversation-engine.ts` for the fast-path comment).
 *
 * The id was previously fetched by `useRobotPeerId`, which probed the
 * daemon's `/api/hf-auth/central-robot-status` endpoint over the
 * WebRTC `http_proxy` channel. That created a chicken-and-egg in LAN
 * mode: WebRTC can't open without a peer id, and the probe needs an
 * open WebRTC. The BLE flow ended up stuck on "Waking up…" forever
 * because the override was never set.
 *
 * The fix is to bypass the daemon entirely for peer id discovery and
 * hit Hugging Face central directly with the user's HF token (which
 * the app gate already validated). That's what the REMOTE flow has
 * always done; we just generalise it to LAN by reusing
 * `fetchRobotsFromCentral`.
 *
 * Two modes, one source of truth
 * ──────────────────────────────
 *   - REMOTE: the user already picked a card from central's listing
 *     on the discovery screen, so the peer id is on `target.robot`.
 *     The hook short-circuits, no network call.
 *   - LAN/BLE: the user picked a robot from the BLE scan list, which
 *     does not carry the central peer id. The hook fetches the user's
 *     fleet from central and matches by name.
 *
 * Name matching strategy
 * ──────────────────────
 * Most users own a single Reachy Mini, so the exact-match path is
 * exercised rarely. We still want it correct:
 *
 *   1. fleet has 1 robot   → use it (no name check needed; user
 *      tapped on the robot they own).
 *   2. fleet has N robots, BLE name matches central `meta.name` /
 *      `name` exactly (case-insensitive, after normalisation) → use
 *      the matched entry.
 *   3. fleet has N robots, no exact match → fall back to `robots[0]`
 *      and warn. The engine still has a chance to recover via SSE
 *      `robotsChanged` if the wrong id was picked, but in practice
 *      central usually orders the user's robots consistently, so
 *      `[0]` is the same robot across calls.
 *
 * Failure modes (LAN)
 * ───────────────────
 * Every error path resolves to `peerId: null, resolved: true`. The
 * engine then falls back to its classic SSE wait, which is slower
 * but still functional when the daemon eventually shows up on
 * central. We never throw and never wedge the screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '../logger';
import {
  extractRobotId,
  extractRobotName,
  fetchRobotsFromCentral,
  type CentralRobotEntry,
} from './fetchRobotsFromCentral';

const logger = createLogger('robot.peerId');

/**
 * Loose connection-target shape, kept local so this hook does not
 * depend on `RobotSessionScreen.tsx` (avoids a circular import).
 */
export type PeerIdTarget =
  | { kind: 'local'; deviceName: string }
  | { kind: 'remote'; robot: CentralRobotEntry };

export interface UseResolvedPeerIdResult {
  /** First entry of central's robot list, or null if none available. */
  peerId: string | null;
  /** True once the initial probe has finished (success or failure). */
  resolved: boolean;
  /** Re-run the probe (LAN only; remote always short-circuits). */
  refresh: () => Promise<void>;
}

function normalizeName(input: string | null | undefined): string {
  if (!input) return '';
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function pickEntryForBleDevice(
  robots: CentralRobotEntry[],
  bleDeviceName: string,
): { entry: CentralRobotEntry | null; reason: string } {
  if (robots.length === 0) {
    return { entry: null, reason: 'empty_fleet' };
  }
  if (robots.length === 1) {
    return { entry: robots[0], reason: 'single_robot' };
  }
  const target = normalizeName(bleDeviceName);
  if (target) {
    const exact = robots.find(
      (r) => normalizeName(extractRobotName(r)) === target,
    );
    if (exact) return { entry: exact, reason: 'name_match' };
    // Looser: substring either way (BLE name may be a serial suffix
    // of the daemon-reported friendly name, or vice-versa).
    const partial = robots.find((r) => {
      const n = normalizeName(extractRobotName(r));
      return n.includes(target) || target.includes(n);
    });
    if (partial) return { entry: partial, reason: 'name_partial' };
  }
  return { entry: robots[0], reason: 'fallback_first' };
}

/**
 * @param target  The connection target the user picked (BLE device or
 *   central card). For BLE we only need the advertised name; for
 *   remote we extract the peer id straight off the entry.
 * @param hfToken App-level Hugging Face token. Required for the LAN
 *   path; the remote path never reads it (peer id is already on the
 *   target). When null in LAN mode the hook resolves to `null` peer
 *   id with a logged warning - the engine will fall back to SSE.
 */
export function useResolvedPeerId(
  target: PeerIdTarget,
  hfToken: string | null,
): UseResolvedPeerIdResult {
  const isRemote = target.kind === 'remote';
  const remoteOverride = isRemote ? extractRobotId(target.robot) : null;

  const [peerId, setPeerId] = useState<string | null>(remoteOverride);
  const [resolved, setResolved] = useState<boolean>(isRemote);

  // Cancellation token for the in-flight probe so `refresh()` is safe
  // to call concurrently and a stale response can never land on a
  // dead component.
  const cancelTokenRef = useRef<{ cancelled: boolean } | null>(null);

  const runLanProbe = useCallback(
    async (deviceName: string, token: string | null): Promise<void> => {
      const cancel = { cancelled: false };
      if (cancelTokenRef.current) {
        cancelTokenRef.current.cancelled = true;
      }
      cancelTokenRef.current = cancel;

      if (!token) {
        logger.warn('lan.no_hf_token');
        if (!cancel.cancelled) {
          setPeerId(null);
          setResolved(true);
        }
        return;
      }

      try {
        const result = await fetchRobotsFromCentral(token);
        if (cancel.cancelled) return;

        if (!result.ok) {
          logger.warn('lan.central_error', { reason: result.reason });
          setPeerId(null);
          setResolved(true);
          return;
        }

        const { entry, reason } = pickEntryForBleDevice(
          result.robots,
          deviceName,
        );
        if (!entry) {
          logger.info('lan.empty_fleet', { device_name: deviceName });
          setPeerId(null);
          setResolved(true);
          return;
        }

        const id = extractRobotId(entry);
        if (!id) {
          logger.warn('lan.no_id_field', { entry });
          setPeerId(null);
          setResolved(true);
          return;
        }

        logger.info('lan.match', {
          device_name: deviceName,
          central_name: extractRobotName(entry),
          peer_id: id,
          reason,
          fleet_size: result.robots.length,
        });
        setPeerId(id);
        setResolved(true);
      } catch (err) {
        if (cancel.cancelled) return;
        logger.warn('lan.error', {
          message: err instanceof Error ? err.message : String(err),
        });
        setPeerId(null);
        setResolved(true);
      }
    },
    [],
  );

  // Pull the variable parts of `target` into stable scalars so the
  // effect dependency array stays statically checkable. Both can be
  // null at the same time only when target.kind itself flips, so the
  // effect re-runs in that case via the `targetKind` dep.
  const targetKind = target.kind;
  const lanDeviceName = target.kind === 'local' ? target.deviceName : null;
  const remoteRobotId =
    target.kind === 'remote' ? extractRobotId(target.robot) : null;

  // Mode-aware effect: REMOTE short-circuits, LAN fires the central
  // probe. Re-runs if the target swaps under us (rare but possible
  // when the screen is reused across different selections).
  useEffect(() => {
    if (targetKind === 'remote') {
      setPeerId(remoteRobotId);
      setResolved(true);
      return;
    }
    setResolved(false);
    setPeerId(null);
    if (lanDeviceName !== null) {
      void runLanProbe(lanDeviceName, hfToken);
    }
    return () => {
      const t = cancelTokenRef.current;
      if (t) t.cancelled = true;
    };
  }, [targetKind, lanDeviceName, remoteRobotId, hfToken, runLanProbe]);

  const refresh = useCallback(async (): Promise<void> => {
    if (target.kind === 'remote') return;
    await runLanProbe(target.deviceName, hfToken);
  }, [target, hfToken, runLanProbe]);

  return { peerId, resolved, refresh };
}
