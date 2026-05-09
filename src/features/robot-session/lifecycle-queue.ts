/**
 * Module-level engine lifecycle queue.
 *
 * The conversation engine opens a long-lived SSE to HF central on
 * `robot.connect()` and a WebRTC peer on `startSession()`. Two of
 * those in flight (StrictMode double-invoke, fast remounts, parent
 * navigating away then straight back into a session) confuse the
 * central relay - both sessions multiplex into the same client
 * stream and the second one's offers/ICE land on a peer connection
 * that doesn't expect them.
 *
 * The queue serialises every mount / unmount through a single
 * promise chain. At most one engine handle is reachable from
 * `ConversationPanel` at any time, and a new mount only starts
 * AFTER the previous unmount has fully settled (gotoSleep,
 * stopSession, disconnect all completed and central acked the
 * session end).
 *
 * Lives at module scope (not inside a component) so the chain is
 * shared across every `<ConversationPanel>` instance the host might
 * render in a single page lifetime.
 */

let engineLifecyclePromise: Promise<void> = Promise.resolve();

/**
 * Queue a lifecycle task. The returned promise resolves once the
 * task itself completes; failures are swallowed so a previous error
 * never blocks subsequent waiters.
 *
 * Internal: only the conversation module mounts engines, so this
 * function isn't part of the public API.
 */
export function chainLifecycle(task: () => Promise<void>): Promise<void> {
  const next = engineLifecyclePromise.then(task).catch((err) => {
    console.warn('[conversation] lifecycle task failed:', err);
  });
  engineLifecyclePromise = next;
  return next;
}

/**
 * Wait until every queued mount/unmount has settled.
 *
 * Use case: the host wants to render a "Putting your Reachy to
 * sleep" transition view while the engine's `unmount()` is still
 * running (gotoSleep + stopSession + disconnect take ~2-3 s on a
 * healthy daemon). Once this resolves the host knows the robot is
 * back to its sleep pose with motors disabled and central has been
 * told the session ended, so it's safe to surface the discovery
 * screen again without confusing the user about whether the robot
 * is still "live".
 *
 * Resolves on the next microtask if the queue is empty. Never
 * rejects - teardown errors are already swallowed inside the chain.
 */
export function flushEngineLifecycle(): Promise<void> {
  return engineLifecyclePromise.then(
    () => undefined,
    () => undefined,
  );
}
