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
import { centralEntryPolicy } from '../presence/centralEntryPolicy';

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
 *
 * `direct` is used for the localhost (this-Mac tray) case: the daemon
 * already told us its own ``central_peer_id`` via /api/daemon/identity,
 * so we have no business going back to central's robot listing - which
 * could pick a homonym in fleets where several robots share the same
 * default name.
 */
export type PeerIdTarget =
  | { kind: 'direct'; peerId: string }
  | {
      kind: 'local';
      deviceName: string;
      /**
       * 16-hex-char prefix of the daemon's persistent ``install_id``
       * as advertised over BLE (TLV tag 0x01). This is the strongest
       * identity we have on a BLE-discovered robot - the same id
       * is published by central as ``meta.install_id``, so a match
       * is exact (not heuristic). Survives daemon restarts /
       * relay reconnects, unlike ``centralPeerIdPrefix`` which
       * rotates. Always preferred over name / peer-id matching.
       */
      installIdPrefix?: string | null;
      /**
       * 16-hex-char prefix of the daemon's ``central_peer_id`` as
       * advertised over BLE (TLV tag 0x02). Volatile (rotates per
       * relay reconnect) but useful as a secondary strong
       * identifier when the daemon happens to be on central at the
       * time of the BLE advert.
       */
      centralPeerIdPrefix?: string | null;
    }
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

/**
 * Resolve the central listing entry for a BLE-discovered robot.
 *
 * Safety contract
 * ───────────────
 * When BLE provided a strong identifier (``installIdPrefix`` or
 * ``centralPeerIdPrefix``), this function returns either:
 *   - the entry whose stable id matches that prefix, OR
 *   - ``null`` (no match) - and the caller MUST treat this as
 *     "we have not seen this physical robot on central yet" rather
 *     than as a license to pick a different robot.
 *
 * This rule is what prevents the 2026-04-29 hijack scenario:
 *   - User has a BLE-discovered robot ``A`` (install_id #639d55…)
 *   - Their HF central listing only contains the **tray** ``B``
 *     (install_id #993bc9…)
 *   - The BLE flow needs a peer id; the old logic fell through to a
 *     "single robot in the fleet ⇒ take it" rule and connected to
 *     ``B``, hijacking the WebRTC away from ``A``.
 * The new contract makes that impossible: we either match the
 * advertised prefix or refuse.
 *
 * Legacy compatibility
 * ────────────────────
 * BLE adverts that pre-date the install_id TLV (``installIdPrefix``
 * AND ``centralPeerIdPrefix`` both null) still need a way to pick a
 * peer id. We then fall back to the heuristic name-based path,
 * which is no worse than the previous behaviour. New daemons publish
 * the install_id so this path will become dead code over time.
 */
function pickEntryForBleDevice(
  robots: CentralRobotEntry[],
  bleDeviceName: string,
  installIdPrefix: string | null,
  centralPeerIdPrefix: string | null,
): { entry: CentralRobotEntry | null; reason: string } {
  if (robots.length === 0) {
    return { entry: null, reason: 'empty_fleet' };
  }
  // Drop rows the user wouldn't even be allowed to tap (kind=tray
  // with health=error, daemon in hard error). A BLE-device-to-central
  // match must never resolve onto a ghost: at best we'd open a
  // session against a peer whose backend is dead, at worst we'd race
  // the central TTL sweeper and disappear mid-handshake.
  robots = robots.filter((r) => {
    const policy = centralEntryPolicy(r);
    return policy.visible && !policy.disabled;
  });
  if (robots.length === 0) {
    return { entry: null, reason: 'no_healthy_candidates' };
  }

  const hasStrongId = Boolean(installIdPrefix || centralPeerIdPrefix);

  // Strongest path: install_id prefix. Persistent across reboots /
  // relay reconnects, propagated by central as `meta.install_id`,
  // and the same value the daemon writes in its `daemon.json`. An
  // exact prefix match here is structurally correct, no heuristic.
  if (installIdPrefix) {
    const wanted = installIdPrefix.toLowerCase();
    const byInstallId = robots.find((r) => {
      const fullId = (r.meta?.install_id ?? '').toLowerCase();
      return fullId.startsWith(wanted);
    });
    if (byInstallId) return { entry: byInstallId, reason: 'install_id_prefix' };
  }

  // Backup strong path: central peer id prefix. Volatile but
  // useful as a fallback for daemons that connected to central
  // before our central server learned to forward `meta.install_id`.
  if (centralPeerIdPrefix) {
    const byPeerId = robots.find((r) => {
      const id = extractRobotId(r);
      if (!id) return false;
      const hex = id.replace(/-/g, '').toLowerCase();
      return hex.startsWith(centralPeerIdPrefix);
    });
    if (byPeerId) return { entry: byPeerId, reason: 'peer_id_prefix' };
  }

  // SAFETY GATE: a strong identifier was advertised but didn't
  // match any healthy central row. We refuse to fall back to
  // name/single_robot/[0] heuristics here: those are guesses, and
  // a guess that picks a different physical robot is the worst
  // possible outcome (silent hijack of the WebRTC session). The
  // engine's SSE-based `robotsChanged` wait will pick up the right
  // robot once it appears on central, which is the correct path
  // for "we're early / robot's relay hasn't connected yet".
  if (hasStrongId) {
    return { entry: null, reason: 'no_strong_id_match' };
  }

  // Legacy path: BLE didn't carry any TLV (very old daemons). Fall
  // back to the heuristic resolver, lossy but better than nothing.
  if (robots.length === 1) {
    return { entry: robots[0], reason: 'legacy_single_robot' };
  }
  const target = normalizeName(bleDeviceName);
  if (target) {
    const exact = robots.find(
      (r) => normalizeName(extractRobotName(r)) === target,
    );
    if (exact) return { entry: exact, reason: 'legacy_name_match' };
    const partial = robots.find((r) => {
      const n = normalizeName(extractRobotName(r));
      return n.includes(target) || target.includes(n);
    });
    if (partial) return { entry: partial, reason: 'legacy_name_partial' };
  }
  // No identifier, no name overlap: refuse rather than risk a
  // wrong-robot connection.
  return { entry: null, reason: 'legacy_no_match' };
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
  // ``direct`` and ``remote`` both short-circuit: we already have a
  // strong peer id to use, no need for a central probe.
  const initialOverride =
    target.kind === 'remote'
      ? extractRobotId(target.robot)
      : target.kind === 'direct'
        ? target.peerId
        : null;
  const initialResolved = target.kind !== 'local';

  const [peerId, setPeerId] = useState<string | null>(initialOverride);
  const [resolved, setResolved] = useState<boolean>(initialResolved);

  // Cancellation token for the in-flight probe so `refresh()` is safe
  // to call concurrently and a stale response can never land on a
  // dead component.
  const cancelTokenRef = useRef<{ cancelled: boolean } | null>(null);

  const runLanProbe = useCallback(
    async (
      deviceName: string,
      installIdPrefix: string | null,
      centralPeerIdPrefix: string | null,
      token: string | null,
    ): Promise<void> => {
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
          installIdPrefix,
          centralPeerIdPrefix,
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
  // effect dependency array stays statically checkable. Each is
  // exclusive (only the matching kind populates its scalar), so the
  // effect re-runs cleanly when the target flips.
  const targetKind = target.kind;
  const lanDeviceName = target.kind === 'local' ? target.deviceName : null;
  const lanInstallIdPrefix =
    target.kind === 'local' ? (target.installIdPrefix ?? null) : null;
  const lanCentralPeerIdPrefix =
    target.kind === 'local' ? (target.centralPeerIdPrefix ?? null) : null;
  const remoteRobotId =
    target.kind === 'remote' ? extractRobotId(target.robot) : null;
  const directPeerId = target.kind === 'direct' ? target.peerId : null;

  // Mode-aware effect: DIRECT and REMOTE short-circuit, LAN fires the
  // central probe. Re-runs if the target swaps under us (rare but
  // possible when the screen is reused across different selections).
  useEffect(() => {
    if (targetKind === 'direct') {
      setPeerId(directPeerId);
      setResolved(true);
      return;
    }
    if (targetKind === 'remote') {
      setPeerId(remoteRobotId);
      setResolved(true);
      return;
    }
    setResolved(false);
    setPeerId(null);
    if (lanDeviceName !== null) {
      void runLanProbe(
        lanDeviceName,
        lanInstallIdPrefix,
        lanCentralPeerIdPrefix,
        hfToken,
      );
    }
    return () => {
      const t = cancelTokenRef.current;
      if (t) t.cancelled = true;
    };
  }, [
    targetKind,
    lanDeviceName,
    lanInstallIdPrefix,
    lanCentralPeerIdPrefix,
    remoteRobotId,
    directPeerId,
    hfToken,
    runLanProbe,
  ]);

  const refresh = useCallback(async (): Promise<void> => {
    if (target.kind !== 'local') return;
    await runLanProbe(
      target.deviceName,
      target.installIdPrefix ?? null,
      target.centralPeerIdPrefix ?? null,
      hfToken,
    );
  }, [target, hfToken, runLanProbe]);

  return { peerId, resolved, refresh };
}
