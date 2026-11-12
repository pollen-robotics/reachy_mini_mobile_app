/**
 * Bring the robot to the latest daemon DURING setup, before Hugging Face
 * sign-in.
 *
 * Robots leave the factory on whatever daemon their OS image shipped (1.8.x,
 * 1.10.0, …). Signing them in first and updating later is what broke
 * out-of-the-box onboarding:
 *   - daemons < 1.10 only know the legacy `/oauth/begin` sign-in, whose
 *     callback depends on `reachy-mini.local` resolving on the phone;
 *   - daemons <= 1.11 store the login where 1.12+ no longer read it, so the
 *     in-session update that follows signs the robot out and the owner has to
 *     redo the whole Bluetooth setup;
 *   - the in-session update screen can't see the restart and reports a
 *     false failure.
 * Updating right after the Wi-Fi join sidesteps all three: sign-in then runs
 * on the latest daemon, once.
 *
 * Transport: the update is started and followed over BLE (`UPDATE_*`, daemon
 * v1.8.2+, see `updateProtocol.ts`), but completion is confirmed over HTTP at
 * the robot's LAN IP. The daemon restarts itself at the end of the update and
 * forgets the job, and the new daemon replaces (and restarts) the BLE service,
 * so BLE goes quiet exactly when the update succeeds. The HTTP version read is
 * the one signal that survives the restart.
 *
 * The orchestration is transport-free (all I/O injected) so it can be tested
 * without a robot.
 */

import { updateLanded } from '@/features/daemon-update/latestRelease';

import type { UpdateCheck, UpdateInfo } from './updateProtocol';

/** Poll cadence while the update runs (BLE job status + HTTP version). */
export const UPDATE_POLL_INTERVAL_MS = 2_500;
/** Hard ceiling for install + restart. A Pi on a slow link can take minutes. */
export const UPDATE_TIMEOUT_MS = 8 * 60_000;

export type RobotUpdateStage = 'installing' | 'restarting';

export interface RobotUpdateProgress {
  stage: RobotUpdateStage;
  /** Daemon version before the update, when the robot reported it. */
  from: string | null;
  /** Version being installed, when the robot reported it. */
  to: string | null;
}

/** The daemon reported the update job as failed. */
export class RobotUpdateFailedError extends Error {
  constructor(detail: string) {
    super(detail || 'The update failed on the robot.');
    this.name = 'RobotUpdateFailedError';
  }
}

/** The robot never came back on the new version before the deadline. */
export class RobotUpdateUnconfirmedError extends Error {
  constructor() {
    super('robot-update-unconfirmed');
    this.name = 'RobotUpdateUnconfirmedError';
  }
}

export type RobotUpdateOutcome =
  /** Already on the latest release: nothing to do. */
  | { kind: 'up-to-date'; version: string | null }
  /** Couldn't check (no PIN session, robot offline, old daemon): carry on
   *  with sign-in on the current version; the in-session gate still applies. */
  | { kind: 'skipped'; reason: string }
  /** Updated and confirmed running the new version. */
  | { kind: 'updated'; version: string };

export interface RobotUpdateDeps {
  /** Re-open the BLE PIN session (it expires after 300 s). */
  reauthenticate: () => Promise<boolean>;
  check: () => Promise<UpdateCheck>;
  start: () => Promise<string>;
  info: (jobId: string) => Promise<UpdateInfo>;
  /** Daemon version read over HTTP at the robot's LAN IP; null if unreachable. */
  readVersion: () => Promise<string | null>;
  isBleConnected: () => boolean;
  /** True once the caller's flow was cancelled (stale runId / unmount). */
  isCancelled: () => boolean;
  onProgress: (progress: RobotUpdateProgress) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Check for a daemon update and, when one is available, install it and wait
 * for the robot to come back on it. Throws `RobotUpdateFailedError` when the
 * daemon reports the job failed, `RobotUpdateUnconfirmedError` on timeout.
 * Returns `null` if the flow was cancelled midway.
 */
export async function updateRobot(deps: RobotUpdateDeps): Promise<RobotUpdateOutcome | null> {
  let check: UpdateCheck;
  try {
    if (!(await deps.reauthenticate())) return { kind: 'skipped', reason: 'pin' };
    check = await deps.check();
  } catch (e) {
    // No update info (robot offline, PyPI unreachable, daemon busy): never
    // block setup on it.
    return { kind: 'skipped', reason: (e as Error).message ?? String(e) };
  }
  if (deps.isCancelled()) return null;
  if (!check.available) return { kind: 'up-to-date', version: check.current };

  const progress: RobotUpdateProgress = {
    stage: 'installing',
    from: check.current,
    to: check.latest,
  };
  deps.onProgress({ ...progress });

  const jobId = await deps.start();
  if (deps.isCancelled()) return null;

  const deadline = deps.now() + UPDATE_TIMEOUT_MS;
  for (;;) {
    const version = await deps.readVersion();
    if (deps.isCancelled()) return null;
    if (version && updateLanded(version, check.current, check.latest)) {
      return { kind: 'updated', version };
    }

    if (progress.stage === 'installing') {
      if (!deps.isBleConnected()) {
        // The new daemon restarts the BLE service: the link dropping is the
        // update finishing, not a failure.
        progress.stage = 'restarting';
      } else {
        try {
          const job = await deps.info(jobId);
          if (job.status === 'failed') throw new RobotUpdateFailedError(job.last);
          if (job.status === 'done') progress.stage = 'restarting';
        } catch (e) {
          if (e instanceof RobotUpdateFailedError) throw e;
          // "Unknown job" / "Daemon unreachable": the daemon restarted and the
          // job went with it.
          progress.stage = 'restarting';
        }
      }
      if (deps.isCancelled()) return null;
      if (progress.stage === 'restarting') deps.onProgress({ ...progress });
    }

    if (deps.now() > deadline) throw new RobotUpdateUnconfirmedError();
    await deps.sleep(UPDATE_POLL_INTERVAL_MS);
    if (deps.isCancelled()) return null;
  }
}
