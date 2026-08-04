/**
 * Robot session bring-up: a single guarded `startSession()` attempt.
 *
 * Wraps `robot.startSession(peerId)` with a timeout guard and returns
 * a discriminated union. There is intentionally NO retry loop.
 *
 * Why no retry
 * ────────────
 * The old code retried twice with a 12 s gap to survive the daemon's
 * intermittent libnice crash (`priv_conn_check_tick_stream_nominate`
 * abort → systemd restart, ~13-16 s blackout). In practice that retry
 * NEVER helped for the failure users actually hit: a STALE peer id.
 *
 * The robot's central peer id rotates on every relay reconnect (each
 * reconnect gets a fresh id from central's `welcome`). A peer id
 * captured a few seconds earlier (at the end of BLE setup, or in a
 * stale robot-list snapshot) points at a producer that no longer
 * exists - so BOTH attempts dialed a dead peer and the user waited
 * ~28 s for nothing.
 *
 * The real fix lives one layer up (`RobotSession.start()`): it
 * RE-RESOLVES the live peer id from central by `hardware_id` right
 * before calling us, so this single attempt targets the current
 * producer. That self-heals against peer-id rotation and makes the
 * retry redundant. Genuine transport drops are handled by the
 * connection controller's background-resilience re-arm, not here.
 *
 * This module stays a pure orchestrator: it takes the SDK robot ref
 * and returns a result. Decoupled from:
 *   - the engine's FSM (no `setState` here)
 *   - the engine's lifecycle queue (we run inline; the host
 *     serialises via `chainLifecycle`)
 *   - the conversation pipeline (no backend / motion concerns)
 */
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';
import type { ConversationConnectionAttempt } from '@/features/conversation/engine/types';
import { SESSION_TIMINGS } from './timings';

/**
 * Sourced from `SESSION_TIMINGS` (centralised in `./timings.ts`) so
 * the bring-up latency can be audited from a single file. Overridable
 * per-call for tests / experiments.
 */
const DEFAULT_ATTEMPT_TIMEOUT_MS = SESSION_TIMINGS.startAttemptTimeoutMs;

export interface StartRobotSessionOptions {
  /** Live SDK instance returned by `new ReachyMini(...)`. */
  robot: ReachyMiniInstance;
  /** Central peer id of the robot to connect to. The caller
   *  (`RobotSession.start()`) is expected to have re-resolved this to
   *  the CURRENT producer id before calling us. */
  peerId: string;
  /**
   * Wrapper used to call `robot.stopSession()` on timeout WITHOUT
   * triggering the engine's unsolicited-drop recovery path. The
   * engine maintains a `pendingExpectedStops` counter that the
   * `sessionStopped` listener checks; passing it in keeps that
   * counter coherent.
   */
  expectedStop: (fn: () => Promise<unknown>) => Promise<void>;
  /** Optional progress callback fired once with `{ attempt: 1,
   *  maxAttempts: 1 }` when the attempt starts and once with `null`
   *  when it settles. The host uses the non-null value only to know
   *  we're in the "Session" bring-up phase (vs. wake-up); there is no
   *  "Reconnecting…" state anymore. */
  onAttempt?: (attempt: ConversationConnectionAttempt | null) => void;
  /** Override the attempt timeout. Defaults to 8 s. */
  attemptTimeoutMs?: number;
  /** Bail before the attempt if this returns `true`. Used by the
   *  engine to abort when the host unmounted us. */
  isCancelled?: () => boolean;
}

export type StartRobotSessionResult =
  | { ok: true }
  | { ok: false; reason: Error; cancelled?: boolean };

/**
 * Run a single guarded bring-up attempt. Resolves once the session is
 * established, or with the failure reason. Never throws.
 */
export async function startRobotSession(
  opts: StartRobotSessionOptions,
): Promise<StartRobotSessionResult> {
  const {
    robot,
    peerId,
    expectedStop,
    onAttempt,
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    isCancelled,
  } = opts;

  const emit = (info: ConversationConnectionAttempt | null): void => {
    if (!onAttempt) return;
    try {
      onAttempt(info);
    } catch (err) {
      console.warn('[start-session] onAttempt callback threw:', err);
    }
  };

  if (isCancelled?.()) {
    emit(null);
    return {
      ok: false,
      reason: new Error('Session start cancelled'),
      cancelled: true,
    };
  }

  emit({ attempt: 1, maxAttempts: 1 });
  console.log(`[start-session] robot.startSession(${peerId})`);
  const result = await tryStartSession(
    robot,
    peerId,
    expectedStop,
    attemptTimeoutMs,
  );
  emit(null);
  if (result.ok) {
    console.log(
      `[DIAG][start-session] SUCCESS — emit(null) (boundary Session→Wake-up)`,
    );
    return { ok: true };
  }
  return { ok: false, reason: result.reason };
}

/**
 * Single attempt with timeout guard. Wraps `robot.startSession()`
 * with a setTimeout that bails out via `expectedStop(stopSession)`
 * to release central's session state when the SDK promise hangs
 * (which it does when the daemon dies mid-handshake - it doesn't
 * reject, it just sits there).
 */
async function tryStartSession(
  robot: ReachyMiniInstance,
  peerId: string,
  expectedStop: (fn: () => Promise<unknown>) => Promise<void>,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; reason: Error; timedOut: boolean }> {
  let timedOut = false;
  const timeoutHandle = window.setTimeout(() => {
    timedOut = true;
    void expectedStop(() => robot.stopSession());
  }, timeoutMs);

  const t0 = performance.now();
  try {
    await robot.startSession(peerId);
    window.clearTimeout(timeoutHandle);
    console.log(
      `[start-session] startSession resolved in ${Math.round(
        performance.now() - t0,
      )}ms, robot.state = ${robot.state}`,
    );
    return { ok: true };
  } catch (err) {
    window.clearTimeout(timeoutHandle);
    console.warn(
      `[start-session] startSession rejected after ${Math.round(
        performance.now() - t0,
      )}ms (timedOut=${timedOut}):`,
      err,
    );
    const reason = timedOut
      ? new Error(
          'Robot did not respond in time. It may be busy with another app. ' +
            'Try again in a moment, or restart the robot if the problem persists.',
        )
      : err instanceof Error
        ? err
        : new Error(String(err));
    return { ok: false, reason, timedOut };
  }
}
