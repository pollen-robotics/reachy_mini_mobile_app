/**
 * Robot session bring-up with auto-retry.
 *
 * Wraps `robot.startSession(peerId)` in a small retry loop that
 * survives the daemon's intermittent libnice crash without
 * surfacing a misleading "Robot did not respond" to the user.
 *
 * Why a retry loop
 * ────────────────
 * The daemon's WebRTC stack (GStreamer + libnice) hits a
 * `priv_conn_check_tick_stream_nominate` assertion on certain
 * ICE nomination races. The assert calls `abort()`, systemd
 * sees the exit code and restarts the daemon. The total
 * blackout is ~13-16 s (RestartSec=3s + ~10-13 s of FastAPI /
 * GStreamer bring-up).
 *
 * Without retry, our single `startSession()` call would just
 * time out and show "Robot did not respond in time" while the
 * daemon was still rebooting. With a 12 s gap between attempts,
 * the second attempt typically lands on a fully recovered
 * daemon and succeeds.
 *
 * This module is the SAFE half of the future RobotSession class
 * extraction: a pure orchestrator that takes the SDK robot ref
 * (still owned by the engine for now) and returns a discriminated
 * union. Easy to unit-test (mock `startSession` to return
 * different sequences), and the engine becomes a thin caller of
 * this function instead of carrying the retry loop inline.
 *
 * Decoupled from:
 *   - the engine's FSM (no `setState` here)
 *   - the engine's lifecycle queue (we run inline; the host
 *     serialises via `chainLifecycle`)
 *   - the conversation pipeline (no backend / motion concerns)
 */
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';
import type { ConnectionAttempt } from './engine/types';
import { SESSION_TIMINGS } from './timings';

/**
 * Defaults are sourced from `SESSION_TIMINGS` (centralised in
 * `./timings.ts`) so the worst-case bring-up latency can be audited
 * from a single file. Each option can still be overridden per-call
 * for tests / experiments.
 */
const DEFAULT_ATTEMPT_TIMEOUT_MS = SESSION_TIMINGS.startAttemptTimeoutMs;
const DEFAULT_RETRY_GAP_MS = SESSION_TIMINGS.startRetryGapMs;
const DEFAULT_MAX_ATTEMPTS = SESSION_TIMINGS.startMaxAttempts;

export interface StartRobotSessionOptions {
  /** Live SDK instance returned by `new ReachyMini(...)`. */
  robot: ReachyMiniInstance;
  /** Central peer id of the robot to connect to. */
  peerId: string;
  /**
   * Wrapper used to call `robot.stopSession()` on timeout WITHOUT
   * triggering the engine's unsolicited-drop recovery path. The
   * engine maintains a `pendingExpectedStops` counter that the
   * `sessionStopped` listener checks; passing it in keeps that
   * counter coherent.
   */
  expectedStop: (fn: () => Promise<unknown>) => Promise<void>;
  /** Optional progress callback fired on each attempt (1-indexed)
   *  and once with `null` at the end (success or final failure).
   *  Lets the host show "Reconnecting… (2 of 2)" in the UI. */
  onAttempt?: (attempt: ConnectionAttempt | null) => void;
  /** Override the per-attempt timeout. Defaults to 8 s. */
  attemptTimeoutMs?: number;
  /** Override the gap between retries. Defaults to 12 s. */
  retryGapMs?: number;
  /** Override the max attempt count. Defaults to 2. */
  maxAttempts?: number;
  /** Bail mid-loop if this returns `true`. Used by the engine to
   *  abort retries when the host unmounted us during the gap. */
  isCancelled?: () => boolean;
}

export type StartRobotSessionResult =
  | { ok: true }
  | { ok: false; reason: Error; cancelled?: boolean };

/**
 * Run the bring-up loop. Resolves once a session is established,
 * or after `maxAttempts` failures. Never throws.
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
    retryGapMs = DEFAULT_RETRY_GAP_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    isCancelled,
  } = opts;

  const emit = (info: ConnectionAttempt | null): void => {
    if (!onAttempt) return;
    try {
      onAttempt(info);
    } catch (err) {
      console.warn('[start-session] onAttempt callback threw:', err);
    }
  };

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      console.log(
        `[start-session] retry ${attempt}/${maxAttempts} after ${retryGapMs}ms gap`,
      );
      // Inform the host BEFORE the gap so the overlay can flip
      // to "Reconnecting…" immediately rather than feeling
      // frozen for 12 s.
      emit({ attempt, maxAttempts });
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, retryGapMs),
      );
      // Bail if the host unmounted us during the gap.
      if (isCancelled?.()) {
        emit(null);
        return {
          ok: false,
          reason: new Error('Session start cancelled'),
          cancelled: true,
        };
      }
    } else {
      emit({ attempt, maxAttempts });
    }

    console.log(
      `[start-session] attempt ${attempt}/${maxAttempts}: robot.startSession(${peerId})`,
    );
    const result = await tryStartSession(
      robot,
      peerId,
      expectedStop,
      attemptTimeoutMs,
    );
    if (result.ok) {
      console.log(
        `[DIAG][start-session] ATTEMPT ${attempt} SUCCESS — about to emit(null) (boundary Session→Wake-up)`,
      );
      emit(null);
      return { ok: true };
    }
    lastError = result.reason;
  }

  emit(null);
  return {
    ok: false,
    reason: lastError ?? new Error('Session start failed (no attempts)'),
  };
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
