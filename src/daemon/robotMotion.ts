/**
 * Motor lifecycle controller (refactored 2026-04-27).
 *
 * Single contract this module enforces
 * ────────────────────────────────────
 *
 * 1. **Sleep ends with `set_mode/disabled`.** Once `goto_sleep.json`
 *    has landed, we cut motor torque for the entire chain. Why:
 *      - `goto_sleep` parks the antennas at ±175° (the mechanical
 *        hard stop). Holding a Dynamixel against its hard stop draws
 *        sustained current; the bus voltage sags, and after a few
 *        cycles the daemon logs "Motor communication error". Disable
 *        is the only honest way to "release" the antennas - any
 *        smooth recovery target either visibly flicks them in front
 *        of the user (`set_target` straight from a hard stop
 *        interpolates at full control-loop speed: looks like the
 *        antennas dive for the sky right after the sleep animation)
 *        or wakes them with a short `goto`, which is just the wake
 *        flow under another name.
 *      - It naturally frees the Dynamixel bus before the next
 *        session, so the wake path always starts from a known
 *        clean state.
 *    The cost - the head can sag a few millimeters under gravity
 *    while the user is offline - is well-paid for: a sagging robot
 *    is exactly what "asleep" should look like.
 *
 *    The next wake re-enables explicitly via `ensureMotorsEnabled`
 *    (idempotent: skips the POST when already enabled) and recovers
 *    from any pose via `preGotoInitIfNeeded`, so the disable here
 *    never wedges the wake loop.
 *
 * 2. **Pre-goto INIT before each canned trajectory.** Both
 *    `wake_up.json` and `goto_sleep.json` ship as absolute-position
 *    trajectories that assume the robot starts near the INIT pose
 *    (head straight, antennas at ±10°). When the robot is in another
 *    pose (e.g. mid-sleep with antennas pinned to ±175°), the first
 *    trajectory sample commands a 170°+ jump - the bus saturates,
 *    drops frames, and the robot ends up "logically completed" but
 *    physically still in sleep pose. Reproduced consistently on the
 *    real robot, recovered consistently by inserting a smooth
 *    `/api/move/goto` to INIT before the play.
 *
 *    The pre-goto is conditional: if the robot is already close to
 *    INIT (cold-boot, or already-awake fast path), we skip it so the
 *    happy path stays at the legacy ~2.5 s.
 *
 * 3. **Event-driven completion with polling fallback.** We open a
 *    WebSocket on `/api/move/ws/updates` (tunneled over the WebRTC
 *    DC's `ws_proxy` channel) and resolve as soon as we see a
 *    `move_completed` / `move_failed` / `move_cancelled` for our
 *    UUID. If the WS handshake fails (older daemon, DC blip), we
 *    fall back to polling `/api/move/running` until the UUID is
 *    gone. Same effective semantics, but the WS path saves up to
 *    one polling tick (~150 ms) per move.
 *
 * 4. **Verification + retry.** After every `wake_up`, we read
 *    `/api/state/full` and check that the head pose lies in the
 *    INIT envelope. If it doesn't (the bug above), we retry once
 *    with a defensive disable→enable cycle to flush the bus, then
 *    pre-goto + wake again. If even that fails, we surface a
 *    `wake_failed` outcome to the UI instead of pretending the
 *    robot is awake.
 *
 * Public API (stable across the refactor)
 * ───────────────────────────────────────
 *
 *   setDesiredState(client, 'awake' | 'sleeping')   // non-blocking
 *   flushPending(): Promise<void>                    // await current chain
 *   getMotionState(): MotionState                    // observable snapshot
 *   subscribeMotion(fn): () => void                  // listener registry
 *   resetMotionSession()                             // hard reset between
 *                                                    //   robot sessions
 *
 * The store coalesces bursts: rapid `setDesiredState` toggles during
 * an in-flight transition finish the current chain, re-read the
 * desired state, and execute at most one more move to land on the
 * final target. Wake-on-mount + sleep-on-unmount stay safe under
 * React effect cleanups (and StrictMode double-invoke).
 *
 * Transport
 * ─────────
 * Every fetch and WebSocket goes through `RobotClient`, which today
 * is always the WebRTC tunnel (`http_proxy` for fetch, `ws_proxy`
 * for WS). Same code path for LAN (ICE picks a host candidate) and
 * remote (TURN-relayed). See `docs/CONNECTION_FLOW.md` §10.
 */

import type { RobotClient, RobotWebSocket } from '../robot-client';
import { createLogger } from '../logger';
import { setTrajectoryPlaying } from './trajectoryGate';

const logger = createLogger('motion');

// ─── Tunables ────────────────────────────────────────────────────────────

/**
 * Settle window after `set_mode/enabled` actually flipped the motors
 * from off → on (cold boot only). The Dynamixel chain takes a
 * moment to accept goal-positions cleanly right after torque-on.
 */
const COLD_BOOT_SETTLE_MS = 600;

/**
 * Polling fallback interval used when the move-updates WebSocket
 * isn't available (older daemon, transient DC blip).
 */
const MOVE_POLL_INTERVAL_MS = 150;

/**
 * Hard ceiling for `playMoveAndWait`. Trajectories finish in ~2-2.5 s
 * on healthy hardware; 8 s leaves headroom for a slow round-trip.
 */
const MOVE_PLAY_TIMEOUT_MS = 8_000;

/**
 * Hard ceiling for `playGotoAndWait`. The pre-goto INIT runs at
 * 1.5 s (configurable per-call); 5 s covers the worst case where
 * the bus needs a second pass.
 */
const GOTO_PLAY_TIMEOUT_MS = 5_000;

/**
 * INIT pose target used by `preGotoInitIfNeeded`. Same value as the
 * daemon's `INIT_HEAD_POSE` (eye(4)) and `INIT_ANTENNAS_JOINT_POSITIONS`
 * (±10° offset).
 */
const INIT_HEAD_POSE = {
  x: 0,
  y: 0,
  z: 0,
  roll: 0,
  pitch: 0,
  yaw: 0,
} as const;
const INIT_ANTENNAS: readonly [number, number] = [-0.1745, 0.1745];

/**
 * Tolerance envelopes for the "is the robot at INIT?" check. Roughly
 * twice what we observed empirically on a healthy bus, to absorb the
 * ~100 ms encoder dither without false-positive retries.
 *
 * - pitch within ±0.1 rad (≈ ±5.7°) of zero
 * - antennas within ±0.5 rad (≈ ±28°) of the target offset
 *
 * Roll, yaw and the XYZ offsets aren't checked: the wake_up
 * trajectory deliberately swings them around, and they relax back
 * to zero on their own.
 */
const INIT_PITCH_TOLERANCE_RAD = 0.1;
const INIT_ANTENNA_TOLERANCE_RAD = 0.5;

/**
 * Duration of the smooth pre-goto to INIT, used to recover from any
 * arbitrary pose before playing a canned trajectory. Min-jerk
 * interpolation, so the actual travel time is always exactly this
 * duration regardless of the start/end distance.
 */
const PRE_GOTO_INIT_DURATION_S = 1.5;

/**
 * Hard ceiling on the number of full wake retries before giving up
 * and surfacing a `wake_failed` outcome. Each retry adds a defensive
 * disable→enable cycle to flush the Dynamixel bus.
 */
const WAKE_MAX_ATTEMPTS = 2;

// ─── Public types ────────────────────────────────────────────────────────

/**
 * Tri-state robot motion state. `'unknown'` is the bootstrap state
 * before we've ever observed the robot. The reconcile loop probes
 * `/api/state/full` on the first call to nail it down.
 */
export type RobotState = 'unknown' | 'awake' | 'sleeping';

/**
 * Outcome of a single wake or sleep transition. The reconcile loop
 * records the most recent value on the store; UI code reads it via
 * `getMotionState()` to decide whether to show an error banner or a
 * "retry" CTA.
 *
 *   - `idle`         : no transition has run yet (initial state).
 *   - `completed`    : trajectory played and post-move verification
 *                      passed.
 *   - `bus_stuck`    : trajectory played but verification failed -
 *                      the daemon broadcast `move_completed` while
 *                      the robot stayed in the wrong pose. Retried
 *                      `WAKE_MAX_ATTEMPTS` times before giving up.
 *   - `play_error`   : `/api/move/play/...` POST returned non-2xx
 *                      or the response had no UUID.
 *   - `move_failed`  : daemon broadcast `move_failed` /
 *                      `move_cancelled` for our UUID.
 *   - `timeout`      : neither the WS nor the polling fallback saw
 *                      the UUID leave running within the deadline.
 *   - `transport_down`: the RobotClient lost its DC mid-transition.
 */
export type MoveOutcome =
  | 'idle'
  | 'completed'
  | 'bus_stuck'
  | 'play_error'
  | 'move_failed'
  | 'timeout'
  | 'transport_down';

/** Snapshot of everything `useMotionState` exposes to React. */
export interface MotionState {
  /** What the user (or the screen) asked for. */
  desired: RobotState;
  /** What we believe the robot actually is, post-verification. */
  current: RobotState;
  /** True while a wake or sleep transition is in flight. */
  inFlight: boolean;
  /**
   * Most recent terminal outcome. Drives the StepperHeader error
   * dot and the conversation panel "robot didn't wake up" banner.
   */
  lastOutcome: MoveOutcome;
  /**
   * True iff it's safe to tear down the WebRTC tunnel without
   * leaving the robot mid-trajectory. False during sleep, true once
   * sleep has resolved (or we've never connected at all). Mirrors
   * the desktop app's `safeToShutdown` flag.
   */
  safeToShutdown: boolean;
}

// ─── Internal types ──────────────────────────────────────────────────────

type MotorMode = 'enabled' | 'disabled' | 'gravity_compensation';

interface MoveTaskUuid {
  uuid: string;
}

interface MotorStatus {
  mode: MotorMode;
}

interface FullStateResponse {
  control_mode?: MotorMode;
  head_pose?: {
    pitch?: number;
    roll?: number;
    yaw?: number;
    x?: number;
    y?: number;
    z?: number;
  } | null;
  antennas_position?: readonly [number, number] | null;
}

interface MoveUpdateMsg {
  type: 'move_started' | 'move_completed' | 'move_failed' | 'move_cancelled';
  uuid: string;
  details?: string;
}

interface Session {
  client: RobotClient;
  desired: RobotState;
  current: RobotState;
  inFlight: boolean;
  lastOutcome: MoveOutcome;
  pending: Promise<void>;
}

let session: Session | null = null;
const listeners = new Set<(s: MotionState) => void>();

// ─── Observable store helpers ────────────────────────────────────────────

function snapshot(): MotionState {
  if (!session) {
    return {
      desired: 'unknown',
      current: 'unknown',
      inFlight: false,
      lastOutcome: 'idle',
      safeToShutdown: true,
    };
  }
  return {
    desired: session.desired,
    current: session.current,
    inFlight: session.inFlight,
    lastOutcome: session.lastOutcome,
    // Safe to shut down when we are not in the middle of any
    // transition AND our resting state is `sleeping` (or unknown
    // pre-handshake). `awake` means motors are at INIT pose holding
    // torque - the screen mustn't tear down WebRTC there or the
    // robot keeps the rest pose without an idle-disable timer.
    safeToShutdown:
      !session.inFlight &&
      (session.current === 'sleeping' || session.current === 'unknown'),
  };
}

function notify(): void {
  if (listeners.size === 0) return;
  const s = snapshot();
  // Iterate over a snapshot so a listener's unsubscribe() inside
  // its own callback doesn't trip the Set iterator.
  for (const fn of Array.from(listeners)) {
    try {
      fn(s);
    } catch (err) {
      logger.warn('listener.threw', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getMotorMode(client: RobotClient): Promise<MotorMode | null> {
  try {
    const resp = await client.fetch<MotorStatus>('/api/motors/status', {
      method: 'GET',
      timeoutMs: 3_000,
    });
    if (!resp.ok || !resp.data) {
      logger.warn('motors.status.failed', { status: resp.status });
      return null;
    }
    return resp.data.mode;
  } catch (err) {
    logger.warn('motors.status.error', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function setMotorMode(
  client: RobotClient,
  mode: 'enabled' | 'disabled',
): Promise<boolean> {
  try {
    const resp = await client.fetch(`/api/motors/set_mode/${mode}`, {
      method: 'POST',
      timeoutMs: 4_000,
    });
    if (!resp.ok) {
      logger.warn('motors.set_mode.failed', {
        mode,
        status: resp.status,
        body: resp.rawBody,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('motors.set_mode.error', {
      mode,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function readFullState(
  client: RobotClient,
): Promise<FullStateResponse | null> {
  try {
    const resp = await client.fetch<FullStateResponse>('/api/state/full', {
      method: 'GET',
      timeoutMs: 3_000,
    });
    if (!resp.ok || !resp.data) return null;
    return resp.data;
  } catch {
    return null;
  }
}

/**
 * Idempotent "make sure motors are torque-on". Steady state: the GET
 * comes back `enabled`, we return immediately. Cold boot only: we
 * POST the mode change and let the Dynamixel bus settle.
 */
async function ensureMotorsEnabled(client: RobotClient): Promise<void> {
  const mode = await getMotorMode(client);
  if (mode === 'enabled') return;
  logger.info('motors.enable.bus_init', { prev: mode ?? 'unknown' });
  await setMotorMode(client, 'enabled');
  await delay(COLD_BOOT_SETTLE_MS);
}

/**
 * Defensive bus reset: disable → small wait → re-enable → settle.
 * Used as the second-attempt recovery when a wake didn't actually
 * move the robot. Costs ~1.1 s but unsticks the Dynamixel chain in
 * most cases.
 */
async function recycleMotorBus(client: RobotClient): Promise<void> {
  logger.info('motors.recycle.start');
  await setMotorMode(client, 'disabled');
  await delay(500);
  await setMotorMode(client, 'enabled');
  await delay(COLD_BOOT_SETTLE_MS);
  logger.info('motors.recycle.done');
}

// ─── Pose helpers ────────────────────────────────────────────────────────

function poseIsCloseToInit(state: FullStateResponse | null): boolean {
  if (!state) return false;
  const pitch = state.head_pose?.pitch;
  const ant = state.antennas_position;
  if (typeof pitch !== 'number' || !ant) return false;
  const pitchOk = Math.abs(pitch) <= INIT_PITCH_TOLERANCE_RAD;
  const antLeftOk =
    Math.abs(ant[0] - INIT_ANTENNAS[0]) <= INIT_ANTENNA_TOLERANCE_RAD;
  const antRightOk =
    Math.abs(ant[1] - INIT_ANTENNAS[1]) <= INIT_ANTENNA_TOLERANCE_RAD;
  return pitchOk && antLeftOk && antRightOk;
}

// ─── playMoveAndWait (event-driven + polling fallback) ───────────────────

/**
 * Subscribe to `/api/move/ws/updates` for the duration of one move
 * and resolve with the terminal event for `targetUuid`. Resolves to
 * `null` if the WS doesn't deliver a terminal event before the
 * deadline (the polling fallback path will handle it instead).
 *
 * Listener cleanup: we close the WS as soon as we resolve, so a
 * dozen back-to-back moves cost a dozen short WS handshakes - cheap,
 * and avoids a "subscriber forever" lifetime that would have to be
 * coupled to the screen's mount/unmount.
 */
function watchMoveCompletionViaWs(
  client: RobotClient,
  targetUuid: string,
  deadlineMs: number,
): Promise<MoveUpdateMsg | null> {
  return new Promise((resolve) => {
    let ws: RobotWebSocket | null = null;
    let settled = false;
    const finish = (val: MoveUpdateMsg | null): void => {
      if (settled) return;
      settled = true;
      if (ws) {
        try {
          ws.close();
        } catch {
          // best-effort
        }
      }
      resolve(val);
    };

    const timer = setTimeout(() => finish(null), deadlineMs);
    try {
      ws = client.openWs('/api/move/ws/updates');
    } catch (err) {
      logger.warn('move.ws.open_threw', {
        uuid: targetUuid,
        message: err instanceof Error ? err.message : String(err),
      });
      clearTimeout(timer);
      finish(null);
      return;
    }

    ws.addEventListener('message', (ev) => {
      let parsed: MoveUpdateMsg | null = null;
      try {
        parsed = JSON.parse(ev.data) as MoveUpdateMsg;
      } catch {
        return;
      }
      if (!parsed || parsed.uuid !== targetUuid) return;
      if (
        parsed.type === 'move_completed' ||
        parsed.type === 'move_failed' ||
        parsed.type === 'move_cancelled'
      ) {
        clearTimeout(timer);
        finish(parsed);
      }
    });
    ws.addEventListener('error', (ev) => {
      logger.warn('move.ws.error', { uuid: targetUuid, error: ev.error });
    });
    ws.addEventListener('close', () => {
      // The daemon closes the WS when its peer closes too; if we get
      // a close before any terminal event, fall through to polling.
      clearTimeout(timer);
      finish(null);
    });
  });
}

/** Poll `/api/move/running` until the UUID is gone or the deadline expires. */
async function watchMoveCompletionViaPolling(
  client: RobotClient,
  targetUuid: string,
  deadlineAtMs: number,
): Promise<'completed' | 'timeout'> {
  let pollIdx = 0;
  let lastStatus = -1;
  while (performance.now() < deadlineAtMs) {
    await delay(MOVE_POLL_INTERVAL_MS);
    pollIdx += 1;
    let stillRunning: boolean | null = null;
    let pollStatus = -1;
    try {
      const list = await client.fetch<MoveTaskUuid[]>('/api/move/running', {
        method: 'GET',
        timeoutMs: 1_500,
      });
      pollStatus = list.status;
      if (list.ok && Array.isArray(list.data)) {
        stillRunning = list.data.some((m) => m.uuid === targetUuid);
      }
    } catch {
      // Transient transport blip, retry on next tick.
    }
    if (pollStatus !== lastStatus) {
      logger.debug('move.poll', {
        uuid: targetUuid,
        idx: pollIdx,
        status: pollStatus,
        still_running: stillRunning,
      });
      lastStatus = pollStatus;
    }
    if (stillRunning === false) return 'completed';
  }
  return 'timeout';
}

/**
 * POST a `play/<name>` endpoint and block until the daemon reports
 * the move task has terminated. Race: WebSocket update vs polling
 * fallback. First-resolved wins.
 *
 * Never throws: every failure path is reflected in the returned
 * `MoveOutcome` so the reconcile loop can keep its promise chain
 * healthy.
 */
async function playMoveAndWait(
  client: RobotClient,
  path: string,
): Promise<MoveOutcome> {
  let uuid: string;
  try {
    logger.info('move.play.request', { path, transport: client.transport });
    const resp = await client.fetch<MoveTaskUuid>(path, {
      method: 'POST',
      timeoutMs: 4_000,
    });
    if (!resp.ok || !resp.data?.uuid) {
      logger.warn('move.play.failed', {
        path,
        status: resp.status,
        body: resp.rawBody,
      });
      return resp.status === 0 ? 'transport_down' : 'play_error';
    }
    uuid = resp.data.uuid;
  } catch (err) {
    logger.warn('move.play.error', {
      path,
      message: err instanceof Error ? err.message : String(err),
    });
    return 'play_error';
  }

  logger.info('move.started', { path, uuid });
  const t0 = performance.now();
  const deadlineAt = t0 + MOVE_PLAY_TIMEOUT_MS;

  // Race the event-driven path against the polling fallback. Both
  // resolve to the same terminal outcome, but the WS path is up to
  // ~150 ms faster on the happy path and immune to a slow polling
  // round-trip on the unhappy path. Either way we get a deterministic
  // result before the deadline.
  type RaceResult =
    | { src: 'ws'; ev: MoveUpdateMsg }
    | { src: 'ws'; ev: null }
    | { src: 'poll'; ev: 'completed' | 'timeout' };
  const wsP: Promise<RaceResult> = watchMoveCompletionViaWs(
    client,
    uuid,
    MOVE_PLAY_TIMEOUT_MS,
  ).then((ev) => ({ src: 'ws', ev }));
  const pollP: Promise<RaceResult> = watchMoveCompletionViaPolling(
    client,
    uuid,
    deadlineAt,
  ).then((ev) => ({ src: 'poll', ev }));

  const result = await Promise.race([wsP, pollP]);
  const latencyMs = Math.round(performance.now() - t0);

  if (result.src === 'ws' && result.ev) {
    logger.info('move.terminal', {
      path,
      uuid,
      via: 'ws',
      type: result.ev.type,
      latency_ms: latencyMs,
    });
    if (result.ev.type === 'move_completed') return 'completed';
    return 'move_failed';
  }
  if (result.src === 'poll' && result.ev === 'completed') {
    logger.info('move.terminal', {
      path,
      uuid,
      via: 'poll',
      type: 'completed',
      latency_ms: latencyMs,
    });
    return 'completed';
  }
  // Either WS closed without a terminal event AND polling is still
  // running, or polling just timed out. Wait once more for whichever
  // is still pending so we don't leak it.
  const fallback = await Promise.race([wsP, pollP]);
  if (fallback.src === 'ws' && fallback.ev?.type === 'move_completed') {
    return 'completed';
  }
  if (fallback.src === 'ws' && fallback.ev) return 'move_failed';
  if (fallback.src === 'poll' && fallback.ev === 'completed') return 'completed';
  logger.warn('move.timeout', {
    path,
    uuid,
    timeout_ms: MOVE_PLAY_TIMEOUT_MS,
  });
  return 'timeout';
}

/**
 * Smooth interpolated goto via `/api/move/goto`. Used as the pre-
 * wake / pre-sleep recovery path: takes the robot from any pose
 * back to INIT in `duration` seconds with min-jerk.
 */
async function playGotoAndWait(
  client: RobotClient,
  duration: number,
): Promise<MoveOutcome> {
  let uuid: string;
  try {
    const resp = await client.fetch<MoveTaskUuid>('/api/move/goto', {
      method: 'POST',
      timeoutMs: 4_000,
      body: {
        head_pose: INIT_HEAD_POSE,
        antennas: INIT_ANTENNAS,
        body_yaw: 0.0,
        duration,
        interpolation: 'minjerk',
      },
    });
    if (!resp.ok || !resp.data?.uuid) {
      logger.warn('goto.play.failed', {
        status: resp.status,
        body: resp.rawBody,
      });
      return resp.status === 0 ? 'transport_down' : 'play_error';
    }
    uuid = resp.data.uuid;
  } catch (err) {
    logger.warn('goto.play.error', {
      message: err instanceof Error ? err.message : String(err),
    });
    return 'play_error';
  }

  logger.info('goto.started', { uuid, duration });
  const t0 = performance.now();
  const deadlineAt = t0 + GOTO_PLAY_TIMEOUT_MS;
  type RaceResult =
    | { src: 'ws'; ev: MoveUpdateMsg | null }
    | { src: 'poll'; ev: 'completed' | 'timeout' };
  const wsP: Promise<RaceResult> = watchMoveCompletionViaWs(
    client,
    uuid,
    GOTO_PLAY_TIMEOUT_MS,
  ).then((ev) => ({ src: 'ws', ev }));
  const pollP: Promise<RaceResult> = watchMoveCompletionViaPolling(
    client,
    uuid,
    deadlineAt,
  ).then((ev) => ({ src: 'poll', ev }));
  const result = await Promise.race([wsP, pollP]);
  const latencyMs = Math.round(performance.now() - t0);

  if (result.src === 'ws' && result.ev?.type === 'move_completed') {
    logger.info('goto.terminal', { uuid, via: 'ws', latency_ms: latencyMs });
    return 'completed';
  }
  if (result.src === 'poll' && result.ev === 'completed') {
    logger.info('goto.terminal', { uuid, via: 'poll', latency_ms: latencyMs });
    return 'completed';
  }
  const fallback = await Promise.race([wsP, pollP]);
  if (fallback.src === 'ws' && fallback.ev?.type === 'move_completed') {
    return 'completed';
  }
  if (fallback.src === 'poll' && fallback.ev === 'completed') {
    return 'completed';
  }
  if (result.src === 'ws' && result.ev?.type) return 'move_failed';
  return 'timeout';
}

/**
 * If the robot is far from INIT (e.g. just woke up in sleep pose
 * after a previous session), play a smooth goto INIT first so the
 * canned `wake_up.json` / `goto_sleep.json` trajectory has its
 * expected starting condition.
 *
 * Cheap (~50 ms) when already at INIT - one `/api/state/full` GET
 * and we return. Only the actual recovery path pays the 1.5 s.
 */
async function preGotoInitIfNeeded(client: RobotClient): Promise<void> {
  const state = await readFullState(client);
  if (poseIsCloseToInit(state)) {
    logger.debug('pre_goto.skip_already_init', {
      pitch: state?.head_pose?.pitch,
      antennas: state?.antennas_position,
    });
    return;
  }
  logger.info('pre_goto.needed', {
    pitch: state?.head_pose?.pitch,
    antennas: state?.antennas_position,
  });
  await playGotoAndWait(client, PRE_GOTO_INIT_DURATION_S);
}

// ─── Sequences ───────────────────────────────────────────────────────────

/**
 * Wake-up: ensureMotorsEnabled → (preGotoInit if needed) → play
 * wake_up → verify → retry on `bus_stuck` with a defensive bus
 * recycle. Trajectory gate goes up before bus contact and stays up
 * for the entire sequence so the 30 Hz wobbler/antennas streams
 * don't fight the trajectory.
 */
async function doWakeUp(client: RobotClient): Promise<MoveOutcome> {
  logger.info('wake.start', { transport: client.transport });
  const t0 = performance.now();
  setTrajectoryPlaying(true);
  try {
    let lastOutcome: MoveOutcome = 'idle';
    for (let attempt = 1; attempt <= WAKE_MAX_ATTEMPTS; attempt += 1) {
      if (attempt === 1) {
        await ensureMotorsEnabled(client);
      } else {
        // Second attempt: the wake silently failed (`bus_stuck`).
        // Cycle the bus to flush any stuck state before retrying.
        logger.warn('wake.retry', { attempt });
        await recycleMotorBus(client);
      }

      await preGotoInitIfNeeded(client);
      const playOutcome = await playMoveAndWait(
        client,
        '/api/move/play/wake_up',
      );
      if (
        playOutcome === 'play_error' ||
        playOutcome === 'transport_down' ||
        playOutcome === 'move_failed' ||
        playOutcome === 'timeout'
      ) {
        lastOutcome = playOutcome;
        if (playOutcome === 'transport_down') break;
        continue;
      }

      // Verify post-move pose. The bus_stuck bug shows up here:
      // the daemon broadcasts `move_completed` on schedule even
      // though the trajectory never reached the bus.
      const finalState = await readFullState(client);
      if (poseIsCloseToInit(finalState)) {
        logger.info('wake.complete', {
          attempt,
          latency_ms: Math.round(performance.now() - t0),
          pitch: finalState?.head_pose?.pitch,
          antennas: finalState?.antennas_position,
        });
        return 'completed';
      }

      logger.warn('wake.bus_stuck', {
        attempt,
        pitch: finalState?.head_pose?.pitch,
        antennas: finalState?.antennas_position,
      });
      lastOutcome = 'bus_stuck';
    }

    logger.error('wake.gave_up', {
      attempts: WAKE_MAX_ATTEMPTS,
      last_outcome: lastOutcome,
      latency_ms: Math.round(performance.now() - t0),
    });
    return lastOutcome === 'idle' ? 'bus_stuck' : lastOutcome;
  } finally {
    setTrajectoryPlaying(false);
  }
}

/**
 * Sleep: (preGotoInit if needed) → play goto_sleep → disable motors.
 *
 * No verification retry: a "stuck sleep" leaves the robot already
 * in a low-energy pose, the user is about to disconnect anyway,
 * and a retry would only delay the leaving phase.
 *
 * The terminal disable is unconditional on a successful play (see
 * file header §1). It MUST run even if the trajectory verification
 * would fail, because the sleep pose holds the antennas against the
 * ±175° hard stop and we cannot leave them under torque - the bus
 * degrades within minutes. Skipped only on `transport_down`, where
 * we couldn't issue the POST anyway.
 */
async function doSleep(client: RobotClient): Promise<MoveOutcome> {
  logger.info('sleep.start', { transport: client.transport });
  const t0 = performance.now();
  setTrajectoryPlaying(true);
  try {
    await preGotoInitIfNeeded(client);
    const outcome = await playMoveAndWait(client, '/api/move/play/goto_sleep');
    if (outcome !== 'transport_down') {
      const ok = await setMotorMode(client, 'disabled');
      logger.info('sleep.motors_disabled', { ok });
    }
    logger.info('sleep.complete', {
      outcome,
      latency_ms: Math.round(performance.now() - t0),
    });
    return outcome;
  } finally {
    setTrajectoryPlaying(false);
  }
}

// ─── Reconcile loop ──────────────────────────────────────────────────────

/**
 * Drain the queue: keep transitioning until `current` matches
 * `desired`. We re-read both on every pass (coalescing bursts), so
 * a flip mid-sequence swings us straight back to the new target on
 * the next iteration.
 */
async function reconcile(s: Session): Promise<void> {
  while (s.current !== s.desired) {
    if (s.desired === 'unknown') break;
    s.inFlight = true;
    notify();
    const target = s.desired;
    let outcome: MoveOutcome;
    if (target === 'awake') {
      outcome = await doWakeUp(s.client);
      // We update `current` to `awake` only if the verification
      // confirms it. Anything else leaves us in the previous state
      // (the loop will retry next iteration if `desired` flipped).
      if (outcome === 'completed') s.current = 'awake';
    } else {
      outcome = await doSleep(s.client);
      // `goto_sleep` has no post-verification (see comment in
      // `doSleep`), so we mark the robot as `sleeping` even on a
      // soft failure - the next session will probe and recover.
      if (outcome !== 'transport_down') s.current = 'sleeping';
    }
    s.lastOutcome = outcome;
    s.inFlight = false;
    notify();
    if (outcome === 'transport_down') break;
    if (outcome !== 'completed') {
      // Don't tight-loop on a permanent failure: bail until the
      // caller flips `desired` again (which will re-arm the chain
      // through `setDesiredState`).
      break;
    }
  }
}

/**
 * One-shot probe to bootstrap `current` on the first reconcile pass.
 * Reads `/api/state/full` and infers awake-vs-sleeping from the
 * head pitch + antenna positions:
 *
 *   - close to INIT → assume `awake`
 *   - antennas pinned at ±175° → assume `sleeping`
 *   - anything else → we don't know; treat as `unknown` so the next
 *     wake/sleep transition runs unconditionally.
 *
 * Falls back to `sleeping` on read failure: that's the safer default
 * because `awake` would skip motor-enable and the trajectory gate.
 */
async function probeInitialState(client: RobotClient): Promise<RobotState> {
  const state = await readFullState(client);
  if (!state) return 'sleeping';
  if (poseIsCloseToInit(state) && state.control_mode === 'enabled') {
    return 'awake';
  }
  const ant = state.antennas_position;
  if (ant && Math.abs(ant[0]) > 2.5 && Math.abs(ant[1]) > 2.5) {
    return 'sleeping';
  }
  return 'unknown';
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Declare what state the robot should be in. The store will reach
 * that state as soon as it can, skipping redundant transitions.
 *
 * Safe to call from any React lifecycle (mount, unmount, re-render,
 * StrictMode double-invoke) - the store absorbs bursts.
 */
export function setDesiredState(
  client: RobotClient,
  desired: 'awake' | 'sleeping',
): void {
  if (!session) {
    session = {
      client,
      desired,
      current: 'unknown',
      inFlight: false,
      lastOutcome: 'idle',
      pending: Promise.resolve(),
    };
    logger.info('session.created', {
      desired,
      transport: client.transport,
    });
    // Bootstrap `current` from the daemon on the first reconcile
    // pass so we don't blindly play wake_up when the robot is
    // already awake (or skip the wake when we think it's awake but
    // it's actually mid-sleep).
    const sBoot = session;
    sBoot.pending = sBoot.pending
      .then(async () => {
        sBoot.current = await probeInitialState(sBoot.client);
        logger.info('session.bootstrap', { current: sBoot.current });
        notify();
      })
      .then(() => reconcile(sBoot))
      .catch((err) => {
        logger.warn('reconcile.error', {
          message: err instanceof Error ? err.message : String(err),
        });
      });
    notify();
    return;
  }

  const prev_client_same = session.client === client;
  const prev_desired = session.desired;
  session.client = client;
  session.desired = desired;
  logger.info('session.updated', {
    prev_desired,
    new_desired: desired,
    current: session.current,
    client_changed: !prev_client_same,
    transport: client.transport,
  });

  const s = session;
  s.pending = s.pending.then(() => reconcile(s)).catch((err) => {
    logger.warn('reconcile.error', {
      message: err instanceof Error ? err.message : String(err),
    });
  });
  notify();
}

/**
 * Await the current pending transition (if any). Useful when a
 * screen needs to block on a clean shutdown sequence - e.g. wait
 * for `goto_sleep` to land before tearing down the WebRTC tunnel.
 *
 * Resolves immediately when the queue is empty. Never rejects:
 * sequence errors are swallowed inside the chain.
 */
export function flushPending(): Promise<void> {
  return session?.pending ?? Promise.resolve();
}

/** Read-only snapshot of the motion store, for `useMotionState`. */
export function getMotionState(): MotionState {
  return snapshot();
}

/**
 * Subscribe to motion state changes. The callback is invoked once
 * with the current snapshot (so callers don't need to bootstrap
 * manually) and again on every transition / desired-state flip.
 *
 * Returns an unsubscribe function. Safe to call from React effects.
 */
export function subscribeMotion(fn: (s: MotionState) => void): () => void {
  listeners.add(fn);
  try {
    fn(snapshot());
  } catch (err) {
    logger.warn('subscriber.threw_bootstrap', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Hard-reset the motion session. Use when the screen unmounts (or
 * a new robot is picked) so the next `setDesiredState` re-probes
 * from scratch instead of inheriting stale state from the
 * previous connection.
 *
 * Does NOT cancel an in-flight transition: the store can't safely
 * interrupt a daemon-side trajectory mid-play. The pending chain
 * is just orphaned (any future `flushPending()` call returns a
 * resolved promise).
 */
export function resetMotionSession(): void {
  if (!session) return;
  logger.info('session.reset', {
    desired: session.desired,
    current: session.current,
    in_flight: session.inFlight,
  });
  session = null;
  notify();
}
