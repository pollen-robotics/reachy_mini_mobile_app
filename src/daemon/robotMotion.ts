/**
 * Robot life-cycle store.
 *
 * Owns the single source of truth for "is the robot we're talking to
 * right now supposed to be awake or asleep?". Any screen that wants
 * to influence this calls `setDesiredState(client, 'awake' |
 * 'sleeping')`; the store decides, independently, when to actually
 * hit the daemon.
 *
 * Transport
 * ─────────
 * The store talks to the daemon through the unified `RobotClient`,
 * which today is always WebRTC `http_proxy`. Same `setDesiredState`
 * call wakes a robot up whether ICE picked a LAN host candidate or a
 * TURN-relayed remote one, which is what lets the connection UI be
 * identical for the BLE-pairing and central-signaling flows.
 *
 * Why a store and not `useEffect` calls directly
 * ────────────────────────────────────────────────
 * The naive approach - fire wake on mount, fire sleep on cleanup -
 * breaks badly the moment anything re-runs the effect:
 *
 *   1. React.StrictMode double-invokes every effect in dev
 *      (mount → cleanup → mount), which sends a wake, then a sleep
 *      2 ms later, then another wake. Each of those is a
 *      300-2000 ms async sequence on the daemon, so they race and
 *      the robot ends up torque-disabled mid-anim.
 *   2. A brief `client` change (re-render with a new transport
 *      instance) also re-runs the effect and retriggers the whole
 *      wake/sleep dance on a robot that never actually changed.
 *   3. On slow networks the sleep POST may still be in flight when
 *      the user navigates back - firing wake on top of an
 *      in-progress sleep puts the daemon in an inconsistent state.
 *
 * The store fixes all three: it tracks a *desired* state and a
 * *current* state, serialises transitions through a single promise
 * chain, and coalesces bursts of setDesiredState calls so only the
 * latest target survives. If the user flips desired state five
 * times during a 2 s sleep animation, the store finishes the sleep,
 * reads the desired state again, and does the one right thing.
 *
 * Daemon contract we rely on (mirrors `useWakeSleep.ts` in the
 * desktop app):
 *
 *   wake:
 *     POST /api/motors/set_mode/enabled       - torque on
 *     wait WAKE_SETTLE_MS                     - absorb serial init
 *     POST /api/move/play/wake_up              - ~2 s trajectory
 *
 *   The settle is intentionally short. Two competing failure modes
 *   shape the value:
 *
 *     (a) Without ANY pause, the daemon's motor controller often hits
 *         a couple of `Serial I/O recovered after N retries` glitches
 *         at the exact moment the wake_up trajectory starts pushing
 *         goal-positions. The Dynamixels go silent during those
 *         retries, so the user sees the trajectory begin, freeze for
 *         ~100-200 ms, and resume from a slightly off pose - perceived
 *         as "the robot snaps then stops then wakes up".
 *
 *     (b) Pausing too long (> ~300 ms) makes the snap-to-goal of the
 *         enable step visible: the head, slumped under gravity while
 *         torque was off, jerks back to the last commanded
 *         (goto_sleep rest) position before the wake_up trajectory's
 *         first interpolation step overrides it.
 *
 *   `WAKE_SETTLE_MS` is the small middle ground where the serial bus
 *   has time to finish its internal retries but the snap stays
 *   subliminal. Tune it if hardware behaviour drifts.
 *
 *   sleep:
 *     POST /api/move/play/goto_sleep           - ~2 s trajectory
 *     wait ~2000 ms                            - let trajectory finish
 *     POST /api/motors/set_mode/disabled       - torque off (floppy)
 *
 * We intentionally do NOT expose a cancellation API: once a wake or
 * sleep sequence has started sending POSTs, it runs to completion.
 * Cancelling mid-sequence would leave the robot in a half-state
 * (motors on, no anim; or anim done, motors still on). Requests
 * queued up behind the current one are free to be superseded though
 * - that's what `desiredState` coalescing is for.
 */

import type { RobotClient } from '../robot-client';
import { createLogger } from '../logger';
import { setTrajectoryPlaying } from './trajectoryGate';

const logger = createLogger('motion');

export type RobotState = 'awake' | 'sleeping';

interface RobotSession {
  /**
   * Stable identity of the connection. Two clients targeting the
   * same physical robot share the same key so the session survives
   * a transport switch (rare in practice, but harmless when it
   * happens, e.g. LAN→remote handover).
   */
  key: string;
  /** Active transport, swapped in if a fresher client arrives. */
  client: RobotClient;
  /** What the UI is asking for right now. */
  desiredState: RobotState;
  /** What the daemon actually has, as far as we know. */
  currentState: RobotState;
  /** Chain all HTTP sequences on a single promise so they serialise. */
  pending: Promise<void>;
}

// There's only ever one robot we're talking to at a time in this app.
// The session is keyed by `key` so that if the user switches robots
// (unlikely but possible) we don't inherit the previous one's state.
let session: RobotSession | null = null;

const GOTO_SLEEP_TRAJECTORY_MS = 2_000;

/**
 * Approximate runtime of `wake_up.json` on the daemon. The POST
 * to `/api/move/play/wake_up` returns immediately (the daemon
 * spawns the trajectory as a background task), so we have to
 * mirror the trajectory length client-side to know when it's
 * safe to release the trajectory gate.
 *
 * Slightly over-budget on purpose: better to keep the wobbler
 * silent for an extra ~250 ms than to clip the tail of the
 * animation with a setHeadPose command.
 */
const WAKE_UP_TRAJECTORY_MS = 2_250;

/**
 * Settle window between enabling motor torque and firing the wake_up
 * trajectory. See the doc comment at the top of the file for the
 * rationale - too short and we step on the daemon's serial-bus init,
 * too long and the Dynamixel snap-to-goal becomes visible.
 */
const WAKE_SETTLE_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Stable session key. The app talks to one robot at a time and the
 * single transport (WebRTC proxy) is enough identity for our needs:
 * a `setDesiredState` call from a fresh client instance pointing at
 * the same robot reuses the same session and just swaps the client
 * pointer in place (`pending` chain unaffected).
 */
function clientKey(_client: RobotClient): string {
  return 'webrtc-proxy';
}

async function postNoBody(
  client: RobotClient,
  path: string,
  label: string,
  timeoutMs = 4_000,
): Promise<boolean> {
  try {
    const resp = await client.fetch(path, { method: 'POST', timeoutMs });
    if (!resp.ok) {
      console.warn(`[robotMotion] ${label} replied ${resp.status}: ${resp.rawBody}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[robotMotion] ${label} failed:`, err);
    return false;
  }
}

async function doWakeUp(client: RobotClient): Promise<void> {
  console.info('[robotMotion] wake sequence → enable motors');
  logger.info('wake.start', { transport: client.transport });
  const t0 = performance.now();
  // Raise the trajectory gate BEFORE re-enabling torque: the snap-to-goal
  // that immediately follows the enable POST otherwise fights the wobbler
  // (which keeps pushing setHeadPose at 30 Hz from the moment OpenAI's
  // output track is wired). See trajectoryGate.ts for the full reasoning.
  setTrajectoryPlaying(true);
  try {
    const enabled = await postNoBody(
      client,
      '/api/motors/set_mode/enabled',
      'enable motors',
    );
    if (!enabled) {
      logger.warn('wake.enable_failed');
      return;
    }
    // Short settle so the daemon-side serial bus can absorb its init
    // retries before the wake_up trajectory starts pushing goal-positions.
    // See the doc comment at the top of the file for the trade-off.
    await sleep(WAKE_SETTLE_MS);
    console.info('[robotMotion] wake sequence → play wake_up');
    await postNoBody(client, '/api/move/play/wake_up', 'play wake_up');
    // Hold the gate up for the full trajectory window. The POST returned
    // ~30 ms in but the daemon will keep streaming wake_up frames for
    // ~2 s; if we drop the gate now the wobbler snaps the head back to
    // identity mid-anim and the user sees the robot freeze.
    await sleep(WAKE_UP_TRAJECTORY_MS);
    logger.info('wake.complete', {
      latency_ms: Math.round(performance.now() - t0),
    });
  } finally {
    setTrajectoryPlaying(false);
  }
}

async function doGotoSleep(client: RobotClient): Promise<void> {
  console.info('[robotMotion] sleep sequence → play goto_sleep');
  logger.info('sleep.start', { transport: client.transport });
  const t0 = performance.now();
  // Same reasoning as doWakeUp: gate the engine's idle pushers so they
  // don't stamp on the goto_sleep trajectory.
  setTrajectoryPlaying(true);
  try {
    const played = await postNoBody(
      client,
      '/api/move/play/goto_sleep',
      'play goto_sleep',
    );
    if (played) {
      await sleep(GOTO_SLEEP_TRAJECTORY_MS);
    }
    console.info('[robotMotion] sleep sequence → disable motors');
    await postNoBody(client, '/api/motors/set_mode/disabled', 'disable motors');
    logger.info('sleep.complete', {
      latency_ms: Math.round(performance.now() - t0),
    });
  } finally {
    setTrajectoryPlaying(false);
  }
}

/**
 * Drain the queue: keep transitioning until currentState matches
 * desiredState. Because `desiredState` can be mutated between
 * iterations (coalescing), we re-read it on every pass instead of
 * capturing a snapshot. Same for `client` - the screen can swap a
 * stale instance in mid-flight (e.g. WebRTC DC reconnected) and we
 * pick the latest pointer for the next sequence.
 */
async function reconcile(s: RobotSession): Promise<void> {
  while (s.currentState !== s.desiredState) {
    const target = s.desiredState;
    if (target === 'awake') {
      await doWakeUp(s.client);
      s.currentState = 'awake';
    } else {
      await doGotoSleep(s.client);
      s.currentState = 'sleeping';
    }
    // Loop: desiredState may have flipped again while we were
    // running the sequence. If so, we swing back immediately.
  }
}

/**
 * Declare what state the robot should be in. The store will reach
 * that state as soon as it can, skipping redundant transitions.
 *
 * Safe to call from any React lifecycle (mount, unmount, re-render,
 * StrictMode double-invoke) - the store absorbs bursts.
 */
export function setDesiredState(client: RobotClient, desired: RobotState): void {
  const key = clientKey(client);
  if (!session || session.key !== key) {
    // New session (or first call). Assume the daemon boots with
    // motors disabled = `sleeping`, which matches the default on
    // every Reachy Mini daemon we've seen. Worst case if the robot
    // actually happens to be already awake, the first wake request
    // will re-issue `set_mode/enabled` (idempotent on the daemon)
    // and replay the wake_up animation - slightly redundant but
    // harmless.
    session = {
      key,
      client,
      desiredState: desired,
      currentState: 'sleeping',
      pending: Promise.resolve(),
    };
  } else {
    // Same robot, possibly fresher transport instance. Update both
    // the desired state and the active client pointer so the next
    // reconcile pass uses whichever DC / HTTP target is current.
    session.desiredState = desired;
    session.client = client;
  }

  const current = session;
  current.pending = current.pending.then(() => reconcile(current)).catch((err) => {
    console.warn('[robotMotion] reconcile threw (swallowed):', err);
  });
}

/**
 * Await the current pending transition (if any). Useful for screens
 * that want to block on a clean shutdown sequence, e.g. waiting for
 * `goto_sleep` to land before tearing down the WebRTC tunnel that
 * would cancel the in-flight POST otherwise.
 */
export function flushPending(): Promise<void> {
  return session?.pending ?? Promise.resolve();
}

/**
 * Drop the in-memory session. Useful if the app is being torn down
 * and you've just sent `sleeping` - call this only AFTER the final
 * transition has drained, otherwise you'll lose the queued sleep
 * command.
 */
export function resetRobotMotion(): void {
  session = null;
}
