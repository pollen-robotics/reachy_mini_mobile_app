/**
 * Typed client for the daemon's app manager, over the SDK's JSON-RPC
 * (`rpcCall`, answered by the daemon's `jsonrpc_relay.py` across the WebRTC
 * data channel).
 *
 * `apps.start / stop / status / restart` drive the single app slot; the
 * management verbs (`list_installed`, `install_space`, `remove`, `update`,
 * `job_status`) need a daemon that ships them. Installs, removals and updates
 * return a job id right away and stream progress as `apps.job_progress`
 * notifications; `job_status` is the polling fallback for a phone that missed
 * some (backgrounded, reconnected).
 */
import type {
  ReachyMiniInstance,
  RpcNotificationHandler,
} from '@/features/robot-session/sdk-types';

import type {
  InstalledRobotApp,
  RobotAppJobKind,
  RobotAppJobStatus,
  RobotAppRunState,
  RobotAppRunStatus,
} from './types';

/** Method the daemon pushes job progress on. */
export const JOB_PROGRESS_METHOD = 'apps.job_progress';

/** Listing reads the venv on the robot; quick, but not instant on a Pi. */
const LIST_TIMEOUT_MS = 15_000;
/** Resolving a Space on the Hub happens before the job id comes back. */
const INSTALL_TIMEOUT_MS = 30_000;
/** A cold Python start, same budget as the conversation app's. */
const START_TIMEOUT_MS = 60_000;
/** The daemon gives an app 20 s to exit before killing it. */
const STOP_TIMEOUT_MS = 30_000;
const RESTART_TIMEOUT_MS = STOP_TIMEOUT_MS + START_TIMEOUT_MS;
const STATUS_TIMEOUT_MS = 5_000;

/** One `apps.job_progress` notification. */
export interface JobProgressEvent {
  jobId: string;
  kind: RobotAppJobKind;
  status: RobotAppJobStatus;
  /** A log line, or `null` on the job's last event. */
  line: string | null;
  /** True on the job's last event, once `status` is final. */
  final: boolean;
}

export interface JobStatusResult {
  status: RobotAppJobStatus;
  logs: string[];
}

export interface RobotAppsClient {
  listInstalled(): Promise<InstalledRobotApp[]>;
  status(): Promise<RobotAppRunStatus>;
  start(name: string): Promise<RobotAppRunStatus>;
  stop(): Promise<void>;
  restart(): Promise<RobotAppRunStatus>;
  /** Starts an install job; resolves with its id and the app's entry name. */
  installSpace(spaceId: string): Promise<{ jobId: string; name: string }>;
  remove(name: string): Promise<{ jobId: string }>;
  update(name: string): Promise<{ jobId: string }>;
  jobStatus(jobId: string): Promise<JobStatusResult>;
  onJobProgress(handler: (event: JobProgressEvent) => void): () => void;
}

interface WireStatus {
  state?: string;
  error?: string | null;
  info?: { name?: string } | null;
}

interface WireInstalled {
  name: string;
  description?: string | null;
  space_id?: string | null;
  title?: string | null;
  emoji?: string | null;
  private?: boolean;
  custom_app_url?: string | null;
}

const RUN_STATES: readonly RobotAppRunState[] = [
  'idle',
  'starting',
  'running',
  'stopping',
  'error',
  'done',
];
const JOB_KINDS: readonly RobotAppJobKind[] = ['install', 'remove', 'update'];
const JOB_STATUSES: readonly RobotAppJobStatus[] = ['pending', 'in_progress', 'done', 'failed'];

export function parseRunStatus(wire: WireStatus | null | undefined): RobotAppRunStatus {
  const state = RUN_STATES.find(s => s === wire?.state) ?? 'idle';
  // A clean exit frees the slot: the daemon reports it as `done` on the
  // REST side and `idle` on the relay; both mean "nothing runs".
  if (state === 'idle' || state === 'done') return { state: 'idle', name: null, error: null };
  return { state, name: wire?.info?.name ?? null, error: wire?.error ?? null };
}

function parseInstalled(wire: WireInstalled): InstalledRobotApp {
  return {
    name: wire.name,
    spaceId: wire.space_id ?? null,
    title: wire.title ?? null,
    description: wire.description ?? '',
    emoji: wire.emoji ?? null,
    private: wire.private === true,
    customAppUrl: wire.custom_app_url ?? null,
  };
}

function parseJobStatus(value: unknown): RobotAppJobStatus {
  return JOB_STATUSES.find(s => s === value) ?? 'in_progress';
}

export function createRobotAppsClient(robot: ReachyMiniInstance): RobotAppsClient {
  return {
    async listInstalled() {
      const res = await robot.rpcCall<{ apps: WireInstalled[] }>(
        'apps.list_installed',
        {},
        { timeoutMs: LIST_TIMEOUT_MS }
      );
      return (res.apps ?? []).map(parseInstalled);
    },
    async status() {
      return parseRunStatus(
        await robot.rpcCall<WireStatus>('apps.status', {}, { timeoutMs: STATUS_TIMEOUT_MS })
      );
    },
    async start(name) {
      return parseRunStatus(
        await robot.rpcCall<WireStatus>('apps.start', { name }, { timeoutMs: START_TIMEOUT_MS })
      );
    },
    async stop() {
      await robot.rpcCall('apps.stop', {}, { timeoutMs: STOP_TIMEOUT_MS });
    },
    async restart() {
      return parseRunStatus(
        await robot.rpcCall<WireStatus>('apps.restart', {}, { timeoutMs: RESTART_TIMEOUT_MS })
      );
    },
    async installSpace(spaceId) {
      const res = await robot.rpcCall<{ job_id: string; name: string }>(
        'apps.install_space',
        { space_id: spaceId },
        { timeoutMs: INSTALL_TIMEOUT_MS }
      );
      return { jobId: res.job_id, name: res.name };
    },
    async remove(name) {
      const res = await robot.rpcCall<{ job_id: string }>('apps.remove', { name });
      return { jobId: res.job_id };
    },
    async update(name) {
      const res = await robot.rpcCall<{ job_id: string }>('apps.update', { name });
      return { jobId: res.job_id };
    },
    async jobStatus(jobId) {
      const res = await robot.rpcCall<{ status: string; logs?: string[] }>(
        'apps.job_status',
        { job_id: jobId },
        { timeoutMs: STATUS_TIMEOUT_MS }
      );
      return { status: parseJobStatus(res.status), logs: res.logs ?? [] };
    },
    onJobProgress(handler) {
      const listener: RpcNotificationHandler = params => {
        const jobId = params.job_id;
        const kind = JOB_KINDS.find(k => k === params.command);
        if (typeof jobId !== 'string' || !kind) return;
        handler({
          jobId,
          kind,
          status: parseJobStatus(params.status),
          line: typeof params.line === 'string' ? params.line : null,
          final: params.final === true,
        });
      };
      return robot.onNotification(JOB_PROGRESS_METHOD, listener);
    },
  };
}
