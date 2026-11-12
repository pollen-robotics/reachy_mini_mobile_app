/**
 * Python apps on the robot: what is installed, what runs, what is being
 * installed or removed.
 *
 * The robot owns all of it. The phone reaches the daemon's app manager over
 * the JSON-RPC relay (`apps.*`, see `client.ts`), never over REST: the REST
 * API is LAN-only and the phone may be anywhere.
 */

/**
 * Whether the connected daemon speaks the app-management verbs.
 * `unknown` until the first answer; `unsupported` when it predates them
 * (`apps.list_installed` answers `method_not_found`).
 */
export type RobotAppsSupport = 'unknown' | 'supported' | 'unsupported';

/** Lifecycle of the single app slot. `idle` when nothing runs. */
export type RobotAppRunState = 'idle' | 'starting' | 'running' | 'stopping' | 'error' | 'done';

export interface RobotAppRunStatus {
  state: RobotAppRunState;
  /** Entry-point name of the app holding the slot, `null` when idle. */
  name: string | null;
  /** Exit code + stderr tail when the app crashed. */
  error: string | null;
}

export const IDLE_RUN_STATUS: RobotAppRunStatus = { state: 'idle', name: null, error: null };

/** One app installed on the robot. */
export interface InstalledRobotApp {
  /** Entry-point name: the id the daemon starts, removes and reports. */
  name: string;
  /** `owner/repo` of the Space it came from, when the daemon kept it. */
  spaceId: string | null;
  title: string | null;
  description: string;
  emoji: string | null;
  private: boolean;
  /** The app's own web UI on the robot's LAN, if it serves one. */
  customAppUrl: string | null;
}

export type RobotAppJobKind = 'install' | 'remove' | 'update';
export type RobotAppJobStatus = 'pending' | 'in_progress' | 'done' | 'failed';

/** An install / remove / update running in the background on the robot. */
export interface RobotAppJob {
  id: string;
  kind: RobotAppJobKind;
  /** Entry-point name (remove / update) or the Space name (install). */
  appName: string;
  /** Set for installs: the catalog id the user picked. */
  spaceId: string | null;
  status: RobotAppJobStatus;
  /** Job log, oldest first, capped (see `MAX_JOB_LOG_LINES`). */
  logs: string[];
}

/** A start / stop / restart the phone is waiting on. */
export interface RobotAppPendingAction {
  kind: 'start' | 'stop' | 'restart';
  name: string | null;
}

export interface RobotAppsSnapshot {
  support: RobotAppsSupport;
  /** `null` until the first successful listing. */
  installed: InstalledRobotApp[] | null;
  running: RobotAppRunStatus;
  job: RobotAppJob | null;
  pending: RobotAppPendingAction | null;
  /**
   * False while the session is down or re-dialing (Wi-Fi blip, handoff):
   * actions are refused locally and the UI shows "Reconnecting…".
   */
  online: boolean;
  /** Last user-facing failure, cleared by the next action. */
  error: string | null;
}

export const MAX_JOB_LOG_LINES = 200;
