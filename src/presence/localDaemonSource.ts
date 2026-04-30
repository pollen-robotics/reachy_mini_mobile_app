/**
 * `useLocalDaemonSource` - detect a Reachy Mini daemon listening on
 * `127.0.0.1:8000` and surface it as a third discovery section in the
 * `ScanScreen`.
 *
 * Why a separate source?
 * ──────────────────────
 * BLE finds Reachies physically next to the user (typically pre-Wi-Fi
 * setup), and the HF central source finds robots that have been
 * claimed and registered on the Hugging Face fleet. Neither covers
 * the case where the user runs the **tray** app on the same Mac as
 * this Tauri build: the daemon is already accepting HTTP calls on
 * `localhost:8000` and just needs to be named to become a first-class
 * citizen on central. This source closes that gap by polling the
 * loopback endpoint and turning a successful response into a tappable
 * row.
 *
 * Platform behaviour
 * ──────────────────
 * On mobile builds (iOS / Android) the loopback points at the phone
 * itself, where no daemon ever runs. The probe will simply time out
 * forever and the `ScanScreen` keeps the section hidden. We don't
 * bother sniffing the platform: a silent miss is cheaper than a flaky
 * platform check.
 *
 * Why not piggy-back on `useDaemonStatus`?
 * ────────────────────────────────────────
 * `useDaemonStatus` belongs to the in-session world (already chosen a
 * robot, transport up). Here we only need a lightweight liveness probe
 * that yields the robot name + source, with no FSM ties. Keeping it
 * separate also means the polling pace can be more aggressive (we want
 * the row to appear within ~5s of the user launching the tray) without
 * affecting in-session daemon status reads.
 *
 * Invariants for the discovery aggregator
 * ───────────────────────────────────────
 * A daemon answering on `127.0.0.1:8000` is, by construction:
 *   - a **tray** daemon (the Mac-side desktop app's sidecar). A real
 *     Reachy Mini robot is on the network at its own IP, never on
 *     the loopback of the phone / Mac running this app.
 *   - a **USB / wired** transport from the daemon's point of view. The
 *     daemon talks to the robot over USB on the same machine; "Wi-Fi"
 *     as a `wireless_version` only describes how the robot reaches the
 *     world, which is irrelevant for a tray. We surface this in the
 *     UI as `wireless_version=false` (kept as a concrete bool so the
 *     "USB" / "WiFi" chip code path stays uniform with central rows).
 * The exported `LOCAL_DAEMON_KIND` and `LOCAL_DAEMON_WIRELESS`
 * constants below are the canonical place those defaults live, so the
 * future aggregator can reuse them instead of re-deriving them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getRobotNameOverLan,
  type RobotNameInfo,
} from '../daemon/daemonRobotName';
import { daemonFetch } from '../daemon/daemonFetch';
import { createLogger } from '../logger';

const logger = createLogger('local-daemon.source');

/**
 * Loopback host the daemon listens on when bound to localhost-only.
 * Kept as an exported constant so call sites that connect through
 * this source use the exact same string the probe used.
 */
export const LOCAL_DAEMON_HOST = '127.0.0.1';

/**
 * Kind to surface for any local-daemon entry. See the file header
 * "Invariants" section: a daemon on `127.0.0.1` is always the
 * desktop tray. The aggregator can rely on this without probing
 * anything else.
 */
export const LOCAL_DAEMON_KIND = 'tray' as const;

/**
 * Wireless flag to surface for any local-daemon entry. Always
 * `false` because:
 *   - the tray talks to its robot over USB (wired);
 *   - a Wi-Fi-paired robot would be on the LAN at its own IP, never
 *     on the loopback of this app's host;
 * so a "Wi-Fi" chip on a localhost row would be a lie. We expose
 * this as a concrete `false` (rather than `null`) so the chip-rendering
 * pipeline that branches on `wireless_version === true / false` can
 * stay uniform with central rows.
 */
export const LOCAL_DAEMON_WIRELESS = false as const;

/**
 * Polling cadence while the section is empty (no daemon detected) - we
 * want to surface a freshly-launched tray within ~5 s of the user
 * opening the app.
 */
const POLL_FAST_MS = 5_000;

/**
 * Slower cadence once we already have a daemon: the row is rendered,
 * cycling at fast cadence is wasteful. We still want to detect a
 * daemon shutdown within a reasonable time, hence not infinity.
 */
const POLL_SLOW_MS = 15_000;

/**
 * Probe timeout. Loopback is fast when present; if we don't get an
 * answer in 1.5 s the daemon is almost certainly absent and a longer
 * wait would only delay the next probe.
 */
const PROBE_TIMEOUT_MS = 1_500;

export interface LocalDaemonInfo {
  /** Always equal to `LOCAL_DAEMON_HOST` for now; left as a field so a
   *  future "discover via mDNS on this machine" could reuse the type. */
  host: string;
  /**
   * Stable per-install reconciliation key (UUID4 hex) returned by
   * `GET /api/daemon/identity`. Same value also surfaces on the same
   * robot's mDNS TXT record, BLE GATT, and HF central listing meta -
   * so the robot registry can dedupe a "loopback" sighting against
   * the corresponding "central" / "BLE" rows. `null` only on legacy
   * daemons that don't expose `/identity` (those are filtered out
   * earlier by the `MIN_API_REVISION` guard so this is mostly
   * informational).
   */
  installId: string | null;
  /**
   * Producer peer id central just assigned this daemon on the latest
   * ``welcome`` frame, when the relay is connected. Used by the scan
   * screen to dedupe a "this Mac" loopback row against the same
   * physical robot's central listing while the HF central server does
   * not propagate ``meta.install_id``. Volatile - re-read on every
   * probe; do NOT persist anywhere.
   */
  centralPeerId: string | null;
  /** Daemon-reported name + source ("default", "persisted", "cli"). */
  robotName: string;
  robotNameSource: RobotNameInfo['source'];
  /** Daemon API revision: lets the UI hide naming on too-old daemons. */
  apiRevision: string | null;
  /** Daemon software version (free-form string). */
  daemonVersion: string | null;
  /** Epoch ms of the last successful probe. */
  lastSeenAt: number;
}

export type LocalDaemonState =
  | { kind: 'absent' }
  | { kind: 'ready'; daemon: LocalDaemonInfo };

export interface UseLocalDaemonSourceResult {
  state: LocalDaemonState;
  /** Trigger an immediate probe outside of the polling cadence. */
  refresh: () => Promise<void>;
}

interface DaemonVersionResponse {
  version?: string;
  api_revision?: string;
}

interface DaemonIdentityResponse {
  install_id?: string;
  robot_name?: string;
  /**
   * Producer peer id assigned to the daemon by the HF central
   * signaling server on the latest ``welcome`` frame. Volatile
   * (rotates per reconnect) but useful as a fallback dedup key
   * against the central listing while the central server does not
   * yet propagate ``meta.install_id``. Null when the relay is
   * offline (no token, no network, ...).
   */
  central_peer_id?: string | null;
}

/**
 * Minimum api_revision the local-daemon section requires.
 *
 * Revision history:
 *   - 2: GET / POST /api/daemon/robot-name (rename support)
 *   - 3: GET /api/daemon/identity (install_id) + central relay no
 *        longer gated on a custom robot name
 *
 * We require >= 3 here: the robot registry hard-depends on
 * `install_id` to dedupe a loopback row with the same robot's central
 * sighting, so a rev-2 daemon would surface as an undedupable ghost.
 * Better hide it than show it twice.
 */
const MIN_API_REVISION = 3;

interface SourceOpts {
  /** Override poll cadence in tests. 0 disables polling. */
  fastMs?: number;
  slowMs?: number;
}

/**
 * Probe `127.0.0.1:8000` once. Returns the local daemon info on
 * success or `null` on any failure - the caller decides what that
 * absence means for state.
 */
async function probeLocalDaemon(): Promise<LocalDaemonInfo | null> {
  try {
    const versionResp = await daemonFetch<DaemonVersionResponse>(
      LOCAL_DAEMON_HOST,
      '/api/daemon/version',
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (!versionResp.ok || !versionResp.data) return null;

    const apiRevision = versionResp.data.api_revision ?? null;
    const apiRevisionNum = apiRevision !== null ? Number(apiRevision) : NaN;
    if (!Number.isFinite(apiRevisionNum) || apiRevisionNum < MIN_API_REVISION) {
      // Daemon is alive but too old: the rename endpoints aren't there
      // yet, so we can't gate-then-name like the new flow expects. Fall
      // through to "absent" - the user notices the row never showing up
      // and (hopefully) restarts their tray to pick up the new build.
      logger.debug('daemon_too_old', {
        api_revision: apiRevision,
        required: MIN_API_REVISION,
      });
      return null;
    }

    const nameInfo = await getRobotNameOverLan(LOCAL_DAEMON_HOST, {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    // The robot-name route is mandatory once api_revision >= 2; if it
    // 404s here something is broken on the daemon side, treat as absent
    // rather than silently substituting a default label.
    if (!nameInfo) return null;

    // Identity: install_id is the registry's reconciliation key, so
    // we treat a missing one as a hard failure (revision check above
    // should already have caught this). Done after the name fetch so
    // the daemon only sees one extra round-trip per probe.
    const identityResp = await daemonFetch<DaemonIdentityResponse>(
      LOCAL_DAEMON_HOST,
      '/api/daemon/identity',
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    const installId =
      identityResp.ok && identityResp.data?.install_id
        ? identityResp.data.install_id
        : null;
    if (!installId) {
      logger.warn('identity_missing_install_id', {
        api_revision: apiRevision,
      });
      return null;
    }
    // ``central_peer_id`` is best-effort: it lives on the same response
    // as ``install_id`` so we get it for free, but the relay may not be
    // up yet (no HF token, no network) in which case the daemon returns
    // null. Treat any falsy value as "unknown" rather than failing the
    // probe - the loopback row is still useful without it.
    const centralPeerId =
      identityResp.ok && identityResp.data?.central_peer_id
        ? identityResp.data.central_peer_id
        : null;

    return {
      host: LOCAL_DAEMON_HOST,
      installId,
      centralPeerId,
      robotName: nameInfo.name,
      robotNameSource: nameInfo.source,
      apiRevision,
      daemonVersion: versionResp.data.version ?? null,
      lastSeenAt: Date.now(),
    };
  } catch {
    // `daemonFetch` already logs failures at WARN; we don't want to
    // double-log every empty probe so swallow here.
    return null;
  }
}

export function useLocalDaemonSource(
  opts: SourceOpts = {},
): UseLocalDaemonSourceResult {
  const fastMs = opts.fastMs ?? POLL_FAST_MS;
  const slowMs = opts.slowMs ?? POLL_SLOW_MS;

  const [state, setState] = useState<LocalDaemonState>({ kind: 'absent' });

  // `stateRef` lets the polling effect read the current state inside a
  // closure without re-creating the interval every render. The schedule
  // effect rebuilds itself only when cadence flips empty <-> ready.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Bumped on every probe so a late response from a previous probe
  // can't overwrite a fresh result.
  const probeIdRef = useRef(0);

  const runProbe = useCallback(async () => {
    const id = ++probeIdRef.current;
    const info = await probeLocalDaemon();
    if (id !== probeIdRef.current) return;

    if (info) {
      setState((prev) => {
        // Only emit a state change when something material moved (name,
        // source, version) so React doesn't re-render the tree on every
        // 5s heartbeat for an unchanged daemon.
        if (
          prev.kind === 'ready' &&
          prev.daemon.robotName === info.robotName &&
          prev.daemon.robotNameSource === info.robotNameSource &&
          prev.daemon.daemonVersion === info.daemonVersion &&
          prev.daemon.apiRevision === info.apiRevision &&
          prev.daemon.centralPeerId === info.centralPeerId
        ) {
          // Update only the heartbeat timestamp without re-rendering
          // consumers (we do via a new ref but keep state stable).
          return prev;
        }
        if (prev.kind !== 'ready') {
          logger.info('detected', {
            robot_name: info.robotName,
            source: info.robotNameSource,
            api_revision: info.apiRevision,
          });
        } else {
          logger.info('updated', {
            from: prev.daemon.robotName,
            to: info.robotName,
          });
        }
        return { kind: 'ready', daemon: info };
      });
    } else {
      setState((prev) => {
        if (prev.kind === 'absent') return prev;
        logger.info('lost', { last_name: prev.daemon.robotName });
        return { kind: 'absent' };
      });
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    await runProbe();
  }, [runProbe]);

  useEffect(() => {
    // Initial probe on mount.
    void runProbe();

    let intervalHandle: number | null = null;

    const scheduleNext = (): void => {
      if (intervalHandle !== null) {
        window.clearInterval(intervalHandle);
        intervalHandle = null;
      }
      const cadence = stateRef.current.kind === 'ready' ? slowMs : fastMs;
      if (cadence <= 0) return;
      intervalHandle = window.setInterval(() => {
        void runProbe();
      }, cadence);
    };
    scheduleNext();

    // When the app comes back to the foreground after a long pause,
    // refresh immediately - the user may have just launched the tray.
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void runProbe();
        scheduleNext();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (intervalHandle !== null) window.clearInterval(intervalHandle);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // `state.kind` is in deps so the cadence flips when we go absent
    // <-> ready: an empty section polls fast to surface a freshly
    // launched tray, a populated one polls slow to save battery.
  }, [runProbe, fastMs, slowMs, state.kind]);

  return { state, refresh };
}
