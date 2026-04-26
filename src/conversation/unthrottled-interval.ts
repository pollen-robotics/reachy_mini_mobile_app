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
let nextId = 1;
const handlers = new Map<number, () => void>();

function ensureWorker(): Worker {
  if (sharedWorker) return sharedWorker;

  // Inlined worker source so we don't need a separate file in the Vite
  // graph (keeps bundling simple, no chunks, no asset import).
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

  const blob = new Blob([workerSource], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);

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
