/**
 * State of the robot's Python apps, kept in step with the daemon.
 *
 * One controller per robot, outliving the Apps tab's mounts and the session's
 * reconnects: an install keeps running on the robot when the phone looks away,
 * so the job it tracks must survive both. The live robot instance is read
 * through `getRobot()` on every call, never cached past a reconnect.
 *
 * Freshness comes from two sources:
 * - `apps.job_progress` notifications stream install / remove / update logs;
 * - while the Apps tab is on screen (`setActive(true)`), a slow poll of
 *   `apps.status` (+ `apps.job_status` for a running job) catches what
 *   notifications cannot: an app crashing, another client starting one, a
 *   job whose events were lost while the data channel was down.
 *
 * Plain class, no React: `useRobotApps` binds it to a component.
 */
import { rpcErrorReason, type ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { createRobotAppsClient, type JobProgressEvent, type RobotAppsClient } from './client';
import {
  IDLE_RUN_STATUS,
  MAX_JOB_LOG_LINES,
  type RobotAppJob,
  type RobotAppJobKind,
  type RobotAppsSnapshot,
} from './types';

/** Poll cadence while the Apps tab is visible. */
export const STATUS_POLL_MS = 3_000;
/** How long a finished job stays on screen before it clears itself. */
export const JOB_SUCCESS_LINGER_MS = 2_500;
/** Poll `job_status` only once notifications have been quiet this long. */
export const JOB_EVENT_QUIET_MS = 5_000;
/** How long a start waits for a stopping app to free the slot. */
export const SLOT_FREE_TIMEOUT_MS = 25_000;
const SLOT_FREE_POLL_MS = 500;

export interface RobotAppsControllerDeps {
  getRobot: () => ReachyMiniInstance | null;
  /** Injection point for tests. */
  createClient?: (robot: ReachyMiniInstance) => RobotAppsClient;
}

const INITIAL: RobotAppsSnapshot = {
  support: 'unknown',
  installed: null,
  running: IDLE_RUN_STATUS,
  job: null,
  pending: null,
  online: true,
  error: null,
};

const NOT_CONNECTED = 'Reachy is not connected. Wait for it to come back, then retry.';
const RECONNECTING = 'Reconnecting to Reachy. Try again in a moment.';

/** Turns a rejected call into the sentence the UI shows. */
export function describeRobotAppsError(err: unknown): string {
  switch (rpcErrorReason(err)) {
    case 'busy':
      return 'Reachy is already installing or removing an app. Wait for it to finish.';
    case 'app_running':
      return 'Stop the app before changing it.';
    case 'startup_app':
      return 'This app launches when Reachy wakes up. Unset it as startup app from the desktop app first.';
    case 'not_found':
      return 'This app could not be found on Hugging Face.';
    case 'already_running':
      return 'Another app is already running on Reachy.';
    case 'not_running':
      return 'No app is running on Reachy.';
    case 'method_not_found':
      return 'Update Reachy to manage its apps from your phone.';
    case undefined:
      return describeTransportError(err);
    default:
      return err instanceof Error && err.message ? err.message : 'Reachy refused the request.';
  }
}

/**
 * A rejection without a JSON-RPC reason never reached the daemon's answer:
 * the SDK rejects that way on a closed data channel (session down or
 * re-dialing), on a timeout, and when a session teardown flushes the calls.
 */
function describeTransportError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(message)) {
    return "Reachy didn't answer in time. Check it is still connected, then retry.";
  }
  // "data channel not open", or calls flushed by a session teardown.
  return RECONNECTING;
}

/** Wait (bounded) until nothing holds the app slot; a later start reports why not. */
async function waitForFreeSlot(client: RobotAppsClient): Promise<void> {
  const deadline = Date.now() + SLOT_FREE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await client.status()).state === 'idle') return;
    await new Promise(resolve => setTimeout(resolve, SLOT_FREE_POLL_MS));
  }
}

/**
 * `apps.stop`, where "nothing was running" counts as done. Daemons before the
 * management verbs answer that case with `internal_error` instead of
 * `not_running`; a stop that really failed shows up in the next status read.
 */
async function stopTolerant(client: RobotAppsClient): Promise<void> {
  try {
    await client.stop();
  } catch (err) {
    const reason = rpcErrorReason(err);
    if (reason !== 'not_running' && reason !== 'internal_error') throw err;
  }
}

function capLogs(logs: string[]): string[] {
  return logs.length > MAX_JOB_LOG_LINES ? logs.slice(-MAX_JOB_LOG_LINES) : logs;
}

export class RobotAppsController {
  private snapshot: RobotAppsSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly deps: RobotAppsControllerDeps;

  private boundRobot: ReachyMiniInstance | null = null;
  private client: RobotAppsClient | null = null;
  private unsubscribeProgress: (() => void) | null = null;

  private active = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private tickInFlight = false;
  /** Bumped by every start / stop / restart: older status replies are stale. */
  private actionGeneration = 0;
  private lastJobEventAt = 0;
  /** The host's view: session phase `live` and no iframe holding it. */
  private hostOnline = true;
  /** The SDK is re-dialing the session in place (ICE drop). */
  private redialing = false;
  private unbindRobotEvents: (() => void) | null = null;

  constructor(deps: RobotAppsControllerDeps) {
    this.deps = deps;
  }

  // -- store surface (useSyncExternalStore) -----------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RobotAppsSnapshot => this.snapshot;

  private set(patch: Partial<RobotAppsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  // -- visibility --------------------------------------------------------

  /** Poll while the Apps tab is on screen and the session is live. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      void this.refresh();
      this.pollTimer = setInterval(() => void this.tick(), STATUS_POLL_MS);
    } else if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Host-side link state (session phase `live`); see `snapshot.online`. */
  setOnline(online: boolean): void {
    if (online === this.hostOnline) return;
    this.hostOnline = online;
    this.syncOnline();
  }

  private syncOnline(): void {
    const online = this.hostOnline && !this.redialing;
    if (online === this.snapshot.online) return;
    this.set({ online });
    if (!online) return;
    // Back from a drop: whatever happened meanwhile (an app crashed, a job
    // finished, its progress events were lost) is only known to the robot.
    this.lastJobEventAt = 0;
    const job = this.snapshot.job;
    const jobRunning = job !== null && (job.status === 'pending' || job.status === 'in_progress');
    // Off the Apps tab, the next activation refreshes anyway.
    if (this.active || jobRunning) void this.refresh();
  }

  dispose(): void {
    this.setActive(false);
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.unbindRobotEvents?.();
    this.unbindRobotEvents = null;
    this.unsubscribeProgress?.();
    this.unsubscribeProgress = null;
    this.boundRobot = null;
    this.client = null;
    this.listeners.clear();
  }

  // -- reads -------------------------------------------------------------

  /** Re-read the installed list and the app slot. */
  async refresh(): Promise<void> {
    const client = this.ensureClient();
    if (!client) return;
    try {
      const installed = await client.listInstalled();
      this.set({ installed, support: 'supported' });
    } catch (err) {
      if (rpcErrorReason(err) === 'method_not_found') this.set({ support: 'unsupported' });
      else console.warn('[robot-apps] apps.list_installed failed:', err);
    }
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) return;
    const client = this.ensureClient();
    if (!client) return;
    this.tickInFlight = true;
    try {
      // A start/stop in flight owns `running`: a status read that started
      // before it (or lands during it) would flash the old state back.
      if (!this.snapshot.pending) {
        const generation = this.actionGeneration;
        const running = await client.status();
        if (!this.snapshot.pending && generation === this.actionGeneration) this.set({ running });
      }
      const job = this.snapshot.job;
      const quiet = Date.now() - this.lastJobEventAt >= JOB_EVENT_QUIET_MS;
      if (
        job &&
        job.id !== '' &&
        quiet &&
        (job.status === 'pending' || job.status === 'in_progress')
      ) {
        await this.pollJob(client, job);
      }
    } catch (err) {
      console.debug('[robot-apps] poll failed:', err);
    } finally {
      this.tickInFlight = false;
    }
  }

  private async pollJob(client: RobotAppsClient, job: RobotAppJob): Promise<void> {
    let result;
    try {
      result = await client.jobStatus(job.id);
    } catch (err) {
      // The daemon restarted and forgot the job: nothing left to follow.
      if (rpcErrorReason(err) === 'unknown_job') this.finishJob(job.id, 'failed');
      return;
    }
    if (this.snapshot.job?.id !== job.id) return;
    // The daemon's log is the full record; it fills any gap left by
    // notifications lost while the data channel was down.
    this.set({ job: { ...this.snapshot.job, logs: capLogs(result.logs) } });
    if (result.status === 'done' || result.status === 'failed') {
      this.finishJob(job.id, result.status);
    }
  }

  // -- app slot ----------------------------------------------------------

  /** Start `name`, stopping whatever holds the slot first (the UI confirms). */
  async start(name: string): Promise<boolean> {
    return this.runAction({ kind: 'start', name }, async client => {
      const current = this.snapshot.running;
      const live = current.state === 'running' || current.state === 'starting';
      if (live && current.name === name) return;
      // Another app is replaced (the UI asked first); a crashed one still
      // holds the slot until it is stopped. A stop already under way (the
      // Talk tab's teardown, another client) answers `not_running` while the
      // app still holds the slot, hence the wait.
      if (current.state !== 'idle') {
        await stopTolerant(client);
        await waitForFreeSlot(client);
      }
      this.set({ running: await client.start(name) });
    });
  }

  async stop(): Promise<boolean> {
    const name = this.snapshot.running.name;
    return this.runAction({ kind: 'stop', name }, async client => {
      this.set({ running: { ...this.snapshot.running, state: 'stopping' } });
      await stopTolerant(client);
      this.set({ running: IDLE_RUN_STATUS });
    });
  }

  async restart(): Promise<boolean> {
    const name = this.snapshot.running.name;
    return this.runAction({ kind: 'restart', name }, async client => {
      this.set({ running: await client.restart() });
    });
  }

  private async runAction(
    pending: NonNullable<RobotAppsSnapshot['pending']>,
    action: (client: RobotAppsClient) => Promise<void>
  ): Promise<boolean> {
    if (this.snapshot.pending) return false;
    if (!this.snapshot.online) {
      // The call would only fail on a closed data channel; say why up front.
      this.set({ error: RECONNECTING });
      return false;
    }
    const client = this.ensureClient();
    if (!client) {
      this.set({ error: NOT_CONNECTED });
      return false;
    }
    this.actionGeneration += 1;
    this.set({ pending, error: null });
    try {
      await action(client);
      return true;
    } catch (err) {
      console.warn(`[robot-apps] ${pending.kind} failed:`, err);
      this.set({ error: describeRobotAppsError(err) });
      return false;
    } finally {
      this.actionGeneration += 1;
      this.set({ pending: null });
      // Re-read the slot: the action's own answer may already be stale (an
      // app that crashed during its first second reads `running`).
      void this.tick();
    }
  }

  // -- installed set (background jobs) -------------------------------------

  install(spaceId: string): Promise<boolean> {
    const fallbackName = spaceId.split('/').pop() ?? spaceId;
    return this.startJob('install', fallbackName, spaceId, async client => {
      const { jobId, name } = await client.installSpace(spaceId);
      return { jobId, appName: name };
    });
  }

  remove(name: string): Promise<boolean> {
    return this.startJob('remove', name, null, async client => ({
      jobId: (await client.remove(name)).jobId,
      appName: name,
    }));
  }

  update(name: string): Promise<boolean> {
    return this.startJob('update', name, null, async client => ({
      jobId: (await client.update(name)).jobId,
      appName: name,
    }));
  }

  /** Clear a finished job from the snapshot (the user closed its report). */
  dismissJob(): void {
    const job = this.snapshot.job;
    if (job && (job.status === 'done' || job.status === 'failed')) this.set({ job: null });
  }

  private async startJob(
    kind: RobotAppJobKind,
    appName: string,
    spaceId: string | null,
    begin: (client: RobotAppsClient) => Promise<{ jobId: string; appName: string }>
  ): Promise<boolean> {
    const current = this.snapshot.job;
    if (current && (current.status === 'pending' || current.status === 'in_progress')) {
      this.set({ error: describeRobotAppsError({ reason: 'busy' }) });
      return false;
    }
    if (!this.snapshot.online) {
      // The call would only fail on a closed data channel; say why up front.
      this.set({ error: RECONNECTING });
      return false;
    }
    const client = this.ensureClient();
    if (!client) {
      this.set({ error: NOT_CONNECTED });
      return false;
    }
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    // Show the job before the daemon answers: resolving a Space on the Hub
    // takes a moment and the tap needs immediate feedback.
    const placeholder: RobotAppJob = {
      id: '',
      kind,
      appName,
      spaceId,
      status: 'pending',
      logs: [],
    };
    this.set({ job: placeholder, error: null });
    try {
      const started = await begin(client);
      // Progress travels apart from the reply and may have beaten it: keep
      // what it brought, down to a final status (a job that failed at once).
      const raced = this.snapshot.job?.id === started.jobId ? this.snapshot.job : null;
      this.set({
        job: {
          ...placeholder,
          id: started.jobId,
          appName: started.appName,
          status: raced?.status ?? 'in_progress',
          logs: raced?.logs ?? [],
        },
      });
      return true;
    } catch (err) {
      console.warn(`[robot-apps] ${kind} failed to start:`, err);
      this.set({ job: null, error: describeRobotAppsError(err) });
      return false;
    }
  }

  private onJobProgress = (event: JobProgressEvent): void => {
    this.lastJobEventAt = Date.now();
    let job = this.snapshot.job;
    if (!job || (job.id !== event.jobId && job.id !== '')) {
      // Another client's job (or ours, from before a reload): follow it
      // rather than let it run unseen, unless we are watching our own.
      if (job && (job.status === 'pending' || job.status === 'in_progress')) return;
      if (event.final) return;
      job = {
        id: event.jobId,
        kind: event.kind,
        appName: '',
        spaceId: null,
        status: event.status,
        logs: [],
      };
    } else if (job.id === '') {
      // Our placeholder: the reply carrying the id has not landed yet.
      job = { ...job, id: event.jobId };
    }
    const logs = event.line === null ? job.logs : capLogs([...job.logs, event.line]);
    this.set({ job: { ...job, logs, status: event.final ? event.status : job.status } });
    if (event.final) this.finishJob(event.jobId, event.status === 'done' ? 'done' : 'failed');
  };

  private finishJob(jobId: string, status: 'done' | 'failed'): void {
    const job = this.snapshot.job;
    if (!job || job.id !== jobId) return;
    this.set({ job: { ...job, status } });
    void this.refresh();
    if (status === 'done') {
      if (this.lingerTimer) clearTimeout(this.lingerTimer);
      this.lingerTimer = setTimeout(() => {
        this.lingerTimer = null;
        if (this.snapshot.job?.id === jobId) this.set({ job: null });
      }, JOB_SUCCESS_LINGER_MS);
    }
  }

  // -- robot binding -------------------------------------------------------

  /**
   * Follow the SDK's in-place re-dial (`autoReconnect`): the host phase can
   * stay `live` through it, but the data channel is down until it recovers.
   */
  private bindRedialEvents(robot: ReachyMiniInstance): () => void {
    const onReconnecting = () => {
      this.redialing = true;
      this.syncOnline();
    };
    const onSettled = () => {
      this.redialing = false;
      this.syncOnline();
    };
    robot.addEventListener('sessionReconnecting', onReconnecting);
    robot.addEventListener('sessionReconnected', onSettled);
    // A terminal give-up: the host phase takes over from here.
    robot.addEventListener('sessionStopped', onSettled);
    return () => {
      robot.removeEventListener('sessionReconnecting', onReconnecting);
      robot.removeEventListener('sessionReconnected', onSettled);
      robot.removeEventListener('sessionStopped', onSettled);
    };
  }

  /** The client for the live robot, re-bound after every reconnect. */
  private ensureClient(): RobotAppsClient | null {
    const robot = this.deps.getRobot();
    if (robot !== this.boundRobot) {
      this.unsubscribeProgress?.();
      this.unsubscribeProgress = null;
      this.unbindRobotEvents?.();
      this.unbindRobotEvents = null;
      this.redialing = false;
      this.boundRobot = robot;
      this.client = robot ? (this.deps.createClient ?? createRobotAppsClient)(robot) : null;
      if (this.client) this.unsubscribeProgress = this.client.onJobProgress(this.onJobProgress);
      if (robot) this.unbindRobotEvents = this.bindRedialEvents(robot);
      this.syncOnline();
    }
    return this.client;
  }
}
