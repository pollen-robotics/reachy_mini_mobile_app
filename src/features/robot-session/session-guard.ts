/**
 * Session-stop intent counter.
 *
 * `robot.stopSession()` triggers a `sessionStopped` event on the
 * SDK. Two very different scenarios produce that event:
 *
 *   1. WE called `stopSession` deliberately (release, teardown,
 *      watchdog timeout, retry-loop timeout). The caller already
 *      owns the follow-up (state, motor mode, video cache, …);
 *      the listener must NOT run its own recovery path on top.
 *   2. The SDK / central / daemon dropped the session unilaterally
 *      (network drop, central evict, daemon libnice crash, host
 *      kill). Nobody else is responsible - the listener IS the
 *      recovery path.
 *
 * The guard tracks case 1 with a single counter: every internal
 * `stopSession()` call goes through `expectedStop()`, which bumps
 * the counter for the duration of the call (plus one macrotask of
 * grace). The `sessionStopped` listener checks
 * `hasPendingExpectedStop()` and bails if true.
 *
 * Why the deferred decrement
 * ──────────────────────────
 * The listener body can dispatch asynchronously (it awaits inside
 * the listener), so the listener may resume AFTER `expectedStop`
 * returned. We keep the counter > 0 for one macrotask after the
 * promise settles so the resuming listener still reads the count
 * as "we initiated this".
 *
 * Module ownership
 * ────────────────
 * Extracted from the engine because this counter is a session
 * concern, not a conversation concern. The engine creates one
 * `SessionGuard` instance at boot and uses it everywhere. Future
 * code in `features/robot-session/` can take a guard reference
 * instead of pulling closure state out of the engine.
 */
export interface SessionGuard {
  /**
   * Wrap a `robot.stopSession()` call so the engine's
   * `sessionStopped` listener knows WE initiated it. Returns a
   * Promise that resolves when `fn()` completes (errors are
   * swallowed and logged - the caller already owns its own
   * error-recovery path).
   */
  expectedStop: (fn: () => Promise<unknown>) => Promise<void>;
  /**
   * True if at least one `expectedStop()` is currently in flight
   * (or settled within the last macrotask). The listener uses
   * this to distinguish initiated stops from unsolicited drops.
   */
  hasPendingExpectedStop: () => boolean;
}

export function createSessionGuard(): SessionGuard {
  let pendingExpectedStops = 0;

  const expectedStop = (fn: () => Promise<unknown>): Promise<void> => {
    pendingExpectedStops++;
    return fn()
      .catch((err) => {
        console.warn('[session-guard] expectedStop failed:', err);
      })
      .finally(() => {
        // Deferred by one macrotask so an asynchronously-dispatched
        // listener body (one that awaits inside the listener) still
        // sees the count as pending when it resumes.
        window.setTimeout(() => {
          pendingExpectedStops--;
        }, 0);
      }) as Promise<void>;
  };

  const hasPendingExpectedStop = (): boolean => pendingExpectedStops > 0;

  return { expectedStop, hasPendingExpectedStop };
}
