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

/**
 * Minimum api_revision the local-daemon section requires. The naming
 * overlay (mandatory before bridging when the daemon still uses the
 * default `reachy_mini` label) needs `POST /api/daemon/robot-name`,
 * which only exists from rev 2 onwards. On older daemons we hide the
 * row entirely rather than surfacing a tap that can only fail with a
 * cryptic 404; the user reads the "tray is out of date, restart it"
 * banner that the desktop tray itself is supposed to show.
 */
const MIN_API_REVISION = 2;

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

    return {
      host: LOCAL_DAEMON_HOST,
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
          prev.daemon.apiRevision === info.apiRevision
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
