/**
 * Robot life-cycle store.
 *
 * Owns the single source of truth for "is the robot we're talking to
 * right now supposed to be awake or asleep?". Any screen that wants
 * to influence this calls `setDesiredState(client, 'awake' |
 * 'sleeping')`; the store decides, independently, when to actually
 * hit the daemon.
 *
 * Transport agnostic
 * ──────────────────
 * The store doesn't care whether the daemon is reached over a LAN
 * HTTP socket or through the WebRTC `http_proxy` tunnel. It speaks
 * the unified `RobotClient` interface, so the very same `setDesired
 * State` call wakes a robot up regardless of how the user got there
 * (BLE pairing on the same Wi-Fi vs central signaling from another
 * city). This is what lets the connection UI be identical for both
 * transports - both flows fire the same wake/sleep sequence on
 * mount/unmount through this store.
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
 *     wait ~300 ms                             - let servos settle
 *     POST /api/move/play/wake_up              - ~2 s trajectory
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

const WAKE_UP_SETTLE_MS = 300;
const GOTO_SLEEP_TRAJECTORY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Each `RobotClient` instance is recreated on every render of the
 * screen that owns it (LAN host change, remote DC swap, retry…).
 * To make the session sticky across renders we key by transport +
 * an opaque identity hint (LAN: the host string we pass in; remote:
 * the literal "remote" keyword) instead of by the client object
 * reference. The screen still calls `setDesiredState` on every
 * render with a fresh client, and the store quietly swaps the
 * pointer in place.
 */
function clientKey(client: RobotClient): string {
  if (client.transport === 'webrtc-proxy') return 'remote';
  // LAN HTTP client: the only stable identity we have is whatever
  // the screen baked into the client. We don't expose host on the
  // RobotClient type to keep it transport-agnostic, so fall back to
  // the transport label - good enough because the app only ever
  // talks to one LAN robot at a time.
  return 'local-http';
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
  const enabled = await postNoBody(
    client,
    '/api/motors/set_mode/enabled',
    'enable motors',
  );
  if (!enabled) return;
  await sleep(WAKE_UP_SETTLE_MS);
  console.info('[robotMotion] wake sequence → play wake_up');
  await postNoBody(client, '/api/move/play/wake_up', 'play wake_up');
}

async function doGotoSleep(client: RobotClient): Promise<void> {
  console.info('[robotMotion] sleep sequence → play goto_sleep');
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
