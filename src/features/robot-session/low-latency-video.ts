/**
 * Low-latency robot video path (WebCodecs), bypassing the browser's
 * WebRTC jitter buffer.
 *
 * Why
 * ───
 * Measured on a Fairphone 4 (WebView 153) against a 720p30 H.264 robot
 * stream: Chrome's adaptive video jitter buffer held frames 110-220 ms
 * in steady state, and after any transport hiccup (a ~1 s loss burst on
 * Wi-Fi) its target jumped to ~500 ms and took minutes to decay. The
 * SDK's `jitterBufferTarget = 0` only sets a floor; nothing reachable
 * from the page caps or resets the adaptive part. For telepresence that
 * "memory" of past hiccups is what the operator feels as lag.
 *
 * How
 * ───
 * A worker sits on the video receiver as an `RTCRtpScriptTransform`.
 * Every encoded frame is passed straight through to the browser's own
 * pipeline (so `<video>`, vision capture, etc. keep working untouched);
 * while a canvas is attached, the worker ALSO decodes its copy with a
 * hardware `VideoDecoder` (`optimizeForLatency`) and paints it the moment
 * it's decoded. Measured: arrival → painted p50 ≈ 20 ms, p90 ≈ 47 ms,
 * with no drift after hiccups.
 *
 * Constraints
 * ───────────
 *  - Chromium only routes frames into a receiver transform installed
 *    BEFORE the stream starts, i.e. in the `track` event. The SDK owns
 *    the RTCPeerConnection, so `installLowLatencyVideo()` (called once
 *    from `main.tsx`, before any session) wraps the constructor to hook
 *    `track` on every new peer connection - re-dials and reacquires
 *    included.
 *  - Without a canvas attached the worker only forwards frames (one
 *    thread hop), so the cost outside telepresence is negligible.
 *  - Unsupported runtime (no `RTCRtpScriptTransform` / `VideoDecoder` /
 *    `OffscreenCanvas`) → nothing is installed and `attachCanvas`
 *    reports `unsupported`; the UI keeps the plain `<video>`.
 *
 * The worker source is inlined as a blob (same CSP-safe pattern as
 * `unthrottled-interval.ts`: `worker-src 'self' blob:`).
 */

export type LowLatencyUnavailableReason = 'unsupported' | 'not-armed';

export interface LowLatencyStats {
  /** Frames seen by the transform since the last stats read. */
  framesIn: number;
  framesPainted: number;
  decoderErrors: number;
  /** Arrival → painted, ms, over the frames since the last stats read. */
  p50Ms: number | null;
  p90Ms: number | null;
}

export interface AttachCallbacks {
  /** First frame painted: the caller can hide its `<video>` fallback. */
  onFirstFrame: () => void;
  /** Decoder failed; the worker keeps retrying on the next keyframe. */
  onError?: (message: string) => void;
}

const WORKER_SOURCE = `
  let ctx = null, canvasId = null, dec = null, needKey = true, firstSent = false;
  let transformer = null;
  const pending = new Map();
  let seq = 0;
  let stats = { in: 0, painted: 0, errors: 0, lat: [] };
  // Diagnostics only (CDP): per-painted-frame change score, to time
  // motion-to-photon on this path. Dormant unless switched on.
  let probe = null;
  function probeFrame(frame) {
    probe.ctx.drawImage(frame, 0, 0, 32, 18);
    const d = probe.ctx.getImageData(0, 0, 32, 18).data;
    let diff = 0;
    if (probe.prev) { for (let i = 0; i < d.length; i += 4) diff += Math.abs(d[i] - probe.prev[i]) + Math.abs(d[i + 1] - probe.prev[i + 1]); diff /= d.length / 4; }
    probe.prev = d;
    if (probe.events.length < 3000) probe.events.push([performance.timeOrigin + performance.now(), diff]);
  }

  function requestKey() {
    try { if (transformer && transformer.sendKeyFrameRequest) transformer.sendKeyFrameRequest().catch(() => {}); } catch (e) {}
  }
  function resetDecoder() {
    if (dec) { try { dec.close(); } catch (e) {} }
    dec = null; needKey = true; pending.clear();
  }
  function ensureDecoder() {
    if (dec) return;
    dec = new VideoDecoder({
      output: (frame) => {
        const t = pending.get(frame.timestamp); pending.delete(frame.timestamp);
        if (ctx) {
          const c = ctx.canvas;
          if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
            c.width = frame.displayWidth; c.height = frame.displayHeight;
          }
          ctx.drawImage(frame, 0, 0);
          stats.painted++;
          if (probe) probeFrame(frame);
          if (t !== undefined && stats.lat.length < 2000) stats.lat.push(performance.now() - t);
          if (!firstSent) { firstSent = true; postMessage({ type: 'first-frame', id: canvasId }); }
        }
        frame.close();
      },
      error: (e) => {
        stats.errors++;
        postMessage({ type: 'decoder-error', id: canvasId, message: String(e) });
        resetDecoder();
        requestKey();
      },
    });
    dec.configure({ codec: 'avc1.42e01f', hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
  }
  function decodeCopy(frame, arrival) {
    if (!ctx) return;
    const isKey = frame.type === 'key';
    if (needKey && !isKey) return;
    ensureDecoder();
    // Never queue: a backed-up decoder means we'd paint stale frames.
    // Skipping a delta breaks the reference chain, so wait for a key.
    if (dec.decodeQueueSize > 2 && !isKey) { needKey = true; requestKey(); return; }
    const ts = ++seq;
    pending.set(ts, arrival);
    dec.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: ts, data: frame.data }));
    needKey = false;
  }

  onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'attach') {
      ctx = m.canvas.getContext('2d', { alpha: false, desynchronized: true });
      canvasId = m.id; firstSent = false; resetDecoder(); requestKey();
    } else if (m.type === 'detach') {
      if (m.id === canvasId) { ctx = null; canvasId = null; resetDecoder(); }
    } else if (m.type === 'probe') {
      probe = m.on ? { ctx: new OffscreenCanvas(32, 18).getContext('2d', { willReadFrequently: true }), prev: null, events: [] } : null;
    } else if (m.type === 'probe-read') {
      postMessage({ type: 'probe-events', reqId: m.reqId, events: probe ? probe.events.splice(0) : [] });
    } else if (m.type === 'stats') {
      const l = stats.lat.slice().sort((a, b) => a - b);
      postMessage({ type: 'stats', reqId: m.reqId, framesIn: stats.in, framesPainted: stats.painted, decoderErrors: stats.errors,
        p50Ms: l.length ? l[l.length >> 1] : null, p90Ms: l.length ? l[Math.floor(l.length * 0.9)] : null });
      stats = { in: 0, painted: 0, errors: 0, lat: [] };
    }
  };

  onrtctransform = (event) => {
    // New peer connection (session start, re-dial, reacquire): restart
    // the decoder on the new stream's first keyframe.
    transformer = event.transformer;
    resetDecoder(); requestKey();
    const reader = transformer.readable.getReader();
    const writer = transformer.writable.getWriter();
    (async () => {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done) return;
        stats.in++;
        // Decode our copy BEFORE forwarding (writing hands the buffer to
        // the browser). Any failure here must never block the forward.
        try { decodeCopy(frame, performance.now()); } catch (err) { stats.errors++; resetDecoder(); }
        await writer.write(frame);
      }
    })().catch(() => {});
  };
`;

type ScriptTransformCtor = new (worker: Worker, options?: unknown) => unknown;

function scriptTransformCtor(): ScriptTransformCtor | null {
  const ctor = (globalThis as { RTCRtpScriptTransform?: ScriptTransformCtor }).RTCRtpScriptTransform;
  return typeof ctor === 'function' ? ctor : null;
}

export function isLowLatencyVideoSupported(): boolean {
  return (
    scriptTransformCtor() !== null &&
    typeof globalThis.VideoDecoder === 'function' &&
    typeof globalThis.OffscreenCanvas === 'function' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    'transferControlToOffscreen' in HTMLCanvasElement.prototype
  );
}

class LowLatencyVideo {
  private worker: Worker | null = null;
  /** A video receiver of the CURRENT session got our transform. */
  private armed = false;
  private nextId = 1;
  private attachments = new Map<number, AttachCallbacks>();
  private statsWaiters = new Map<number, (s: LowLatencyStats) => void>();
  private probeWaiters = new Map<number, (events: Array<[number, number]>) => void>();

  onVideoTrack(event: RTCTrackEvent): void {
    const Ctor = scriptTransformCtor();
    if (!Ctor || event.track.kind !== 'video') return;
    const worker = this.ensureWorker();
    if (!worker) return;
    try {
      (event.receiver as unknown as { transform: unknown }).transform = new Ctor(worker, {});
      this.armed = true;
    } catch (err) {
      console.warn('[low-latency-video] could not attach receiver transform:', err);
    }
  }

  /**
   * Paint the robot video into `canvas` with minimal latency. Returns a
   * detach function, or the reason the path isn't available (the caller
   * then keeps its `<video>`). The canvas is handed to the worker
   * (`transferControlToOffscreen`), so a canvas element can only be
   * attached once - remount a fresh `<canvas>` to re-attach.
   */
  attachCanvas(
    canvas: HTMLCanvasElement,
    callbacks: AttachCallbacks,
  ): (() => void) | LowLatencyUnavailableReason {
    if (!isLowLatencyVideoSupported()) return 'unsupported';
    if (!this.armed || !this.worker) return 'not-armed';
    const id = this.nextId++;
    let offscreen: OffscreenCanvas;
    try {
      offscreen = canvas.transferControlToOffscreen();
    } catch (err) {
      console.warn('[low-latency-video] transferControlToOffscreen failed:', err);
      return 'unsupported';
    }
    this.attachments.set(id, callbacks);
    this.worker.postMessage({ type: 'attach', id, canvas: offscreen }, [offscreen]);
    return () => {
      this.attachments.delete(id);
      this.worker?.postMessage({ type: 'detach', id });
    };
  }

  /**
   * Diagnostics: score every painted frame for change so motion-to-photon
   * can be timed on this path (`readProbe` → `[epochMs, diff][]`).
   */
  setProbe(on: boolean): void {
    this.worker?.postMessage({ type: 'probe', on });
  }

  readProbe(): Promise<Array<[number, number]>> {
    if (!this.worker) return Promise.resolve([]);
    const reqId = this.nextId++;
    return new Promise((resolve) => {
      this.probeWaiters.set(reqId, resolve);
      this.worker?.postMessage({ type: 'probe-read', reqId });
    });
  }

  /** Latency stats since the previous call (diagnostics). */
  getStats(): Promise<LowLatencyStats | null> {
    if (!this.worker) return Promise.resolve(null);
    const reqId = this.nextId++;
    return new Promise((resolve) => {
      this.statsWaiters.set(reqId, resolve);
      this.worker?.postMessage({ type: 'stats', reqId });
      setTimeout(() => {
        if (this.statsWaiters.delete(reqId)) resolve(null);
      }, 1000);
    });
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
      this.worker = new Worker(url);
    } catch (err) {
      console.warn('[low-latency-video] worker creation failed (CSP worker-src?):', err);
      return null;
    }
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; id?: number; reqId?: number; message?: string } & LowLatencyStats;
      if (m.type === 'first-frame' && m.id !== undefined) this.attachments.get(m.id)?.onFirstFrame();
      else if (m.type === 'decoder-error' && m.id !== undefined) {
        console.warn('[low-latency-video] decoder error:', m.message);
        this.attachments.get(m.id)?.onError?.(m.message ?? 'decoder error');
      } else if (m.type === 'probe-events' && m.reqId !== undefined) {
        const resolve = this.probeWaiters.get(m.reqId);
        this.probeWaiters.delete(m.reqId);
        resolve?.((e.data as { events: Array<[number, number]> }).events);
      } else if (m.type === 'stats' && m.reqId !== undefined) {
        const resolve = this.statsWaiters.get(m.reqId);
        this.statsWaiters.delete(m.reqId);
        resolve?.({
          framesIn: m.framesIn,
          framesPainted: m.framesPainted,
          decoderErrors: m.decoderErrors,
          p50Ms: m.p50Ms,
          p90Ms: m.p90Ms,
        });
      }
    };
    return this.worker;
  }
}

export const lowLatencyVideo = new LowLatencyVideo();

let installed = false;

/**
 * Hook `track` on every RTCPeerConnection created from now on, so the
 * robot video receiver gets the low-latency transform before its first
 * frame. Call once at startup, before any session is created.
 */
export function installLowLatencyVideo(): void {
  if (installed || !isLowLatencyVideoSupported()) return;
  const Original = globalThis.RTCPeerConnection;
  if (typeof Original !== 'function') return;
  installed = true;
  const Wrapped = function (this: unknown, ...args: ConstructorParameters<typeof RTCPeerConnection>) {
    const pc = new Original(...args);
    pc.addEventListener('track', (event) => lowLatencyVideo.onVideoTrack(event));
    return pc;
  } as unknown as typeof RTCPeerConnection;
  Wrapped.prototype = Original.prototype;
  Object.setPrototypeOf(Wrapped, Original);
  globalThis.RTCPeerConnection = Wrapped;
  // On-device diagnostics (CDP): `await __reachyLowLatency.getStats()`.
  (globalThis as { __reachyLowLatency?: LowLatencyVideo }).__reachyLowLatency = lowLatencyVideo;
}
