/**
 * A `setInterval` replacement that keeps firing at the requested rate even
 * when the window/tab loses focus or the mobile app gets backgrounded (while
 * still alive). Motion loops in this app (head-wobbler, antennas, move-player)
 * must tick at 20–100 Hz to keep the robot moving smoothly; the plain
 * `window.setInterval` gets throttled to ~1 Hz by every major browser engine
 * (Chromium, WebKit, Gecko) when the owning document isn't visible.
 *
 * Why a Worker
 * ────────────
 * Web Workers run on a separate thread and are explicitly exempted from
 * background-throttling in all desktop browsers and in WKWebView/Tauri on
 * macOS. We spin up a single shared Worker on first use, and multiplex all
 * callers through `postMessage` with a numeric id.
 *
 * Caveats
 * ───────
 * - On iOS / Android when the **whole app** is fully backgrounded (not just
 *   the window losing focus), the entire WebView process is suspended by the
 *   OS. No JS runs - not main thread, not worker. Nothing this helper can do.
 *   The robot will pause until the user re-opens the app. This is expected
 *   platform behaviour.
 * - `postMessage` crossing the worker boundary adds ~0.1ms of jitter. Plenty
 *   good enough for a 100Hz pose stream.
 * - If the main thread itself is janky (long synchronous task), ticks still
 *   queue up and fire as a burst when the thread becomes free. Same as plain
 *   `setInterval` would do.
 *
 * Cleanup
 * ───────
 * Each handle returned by `createUnthrottledInterval` carries a `clear()`
 * method that unregisters the callback and tells the worker to drop its
 * timer. The worker itself is kept alive for the lifetime of the document -
 * spinning a new worker per timer would waste memory and add startup latency
 * on every `start()` / `stop()` cycle.
 */

type Handle = { clear: () => void };

let sharedWorker: Worker | null = null;
// Sticky null sentinel: once we've decided the Worker path is unavailable
// on this runtime (CSP block, missing API, …) we don't keep retrying on
// every `createUnthrottledInterval` call. Subsequent timers go straight
// to the `setInterval` fallback. A warning is emitted only once at the
// moment of the failure so the JS console reads cleanly.
let workerUnavailable = false;
let nextId = 1;
const handlers = new Map<number, () => void>();

function ensureWorker(): Worker | null {
  if (sharedWorker) return sharedWorker;
  if (workerUnavailable) return null;

  // Inlined worker source so we don't need a separate file in the Vite
  // graph (keeps bundling simple, no chunks, no asset import).
  //
  // CSP requirement
  // ───────────────
  // `new Worker(blob:URL)` requires the document's CSP to allow
  // `blob:` in `worker-src` (or, by fallback, in `default-src`).
  // Tauri prod builds enforce the CSP from `tauri.conf.json`, so the
  // app's CSP MUST include `worker-src 'self' blob:`. Without it the
  // Worker constructor throws SecurityError silently and EVERY motion
  // path on this app dies (head wobble, antennas, pose dispatcher,
  // move player) - the conversation audio still plays but the robot
  // doesn't move. We had this exact regression in 0.5.1; the fallback
  // below + the loud warning in the catch are there to make the next
  // occurrence loud rather than silent.
  const workerSource = `
    const timers = new Map();
    self.onmessage = (e) => {
      const { op, id, ms } = e.data || {};
      if (op === 'start') {
        const t = setInterval(() => postMessage({ id }), ms);
        timers.set(id, t);
      } else if (op === 'stop') {
        const t = timers.get(id);
        if (t !== undefined) {
          clearInterval(t);
          timers.delete(id);
        }
      }
    };
  `;

  let worker: Worker;
  try {
    const blob = new Blob([workerSource], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
  } catch (err) {
    // Most likely CSP rejecting `new Worker(blob:URL)` on a runtime
    // whose `worker-src` (or fallback `default-src`) doesn't list
    // `blob:`. Could also be an exotic embedder that disables Workers
    // wholesale. In both cases we degrade to plain `setInterval`,
    // which loses the background-throttling resilience but keeps
    // motion working when the app is foregrounded - much better than
    // a silent dead robot.
    workerUnavailable = true;
    console.warn(
      "[unthrottled-interval] Worker creation failed - falling back to " +
        "setInterval. Motion will throttle when the app is backgrounded. " +
        "If this is a Tauri prod build, check that tauri.conf.json's CSP " +
        "includes `worker-src 'self' blob:`.",
      err,
    );
    return null;
  }

  worker.onmessage = (e: MessageEvent<{ id: number }>) => {
    const fn = handlers.get(e.data.id);
    if (fn) {
      try {
        fn();
      } catch (err) {
        console.error("[unthrottled-interval] tick threw:", err);
      }
    }
  };

  sharedWorker = worker;
  return worker;
}

/**
 * Start a periodic callback that isn't subject to background-tab throttling.
 *
 * @param callback  Function to invoke on every tick.
 * @param ms        Period in milliseconds. Minimum 4ms (browser clamp).
 * @returns         Handle with a `.clear()` method to stop the timer.
 */
export function createUnthrottledInterval(
  callback: () => void,
  ms: number,
): Handle {
  const worker = ensureWorker();
  if (worker === null) {
    // Fallback path: plain `setInterval`. Same external contract
    // (callback, period, `.clear()`) so callers don't have to
    // branch. The trade-off vs the worker path is documented at the
    // top of `ensureWorker()`.
    const id = window.setInterval(() => {
      try {
        callback();
      } catch (err) {
        console.error("[unthrottled-interval] tick threw:", err);
      }
    }, ms);
    return {
      clear: () => {
        window.clearInterval(id);
      },
    };
  }

  const id = nextId++;
  handlers.set(id, callback);
  worker.postMessage({ op: "start", id, ms });
  return {
    clear: () => {
      if (!handlers.has(id)) return;
      handlers.delete(id);
      worker.postMessage({ op: "stop", id });
    },
  };
}
