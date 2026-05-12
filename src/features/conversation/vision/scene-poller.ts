/**
 * Vision orchestrator.
 *
 * Owns the timer, the in-flight guard and the wiring between the
 * frame capture, the VLM provider, the scene injector and the STT
 * trigger. Exposes `start()` / `stop()` / `dispose()` for the host
 * engine to drive its lifecycle.
 *
 * Three capture paths converge here:
 *   - `initial`: scheduled once at `start()` time, fires after
 *     `initialDelayMs`. Gives the model visual context from the very
 *     first user utterance instead of being blind for 30 s.
 *   - `periodic`: timer-driven, every `intervalMs`. Skipped if a
 *     previous VLM call is still in flight (`inFlight` guard).
 *   - `stt_keyword`: user said one of the trigger words. Preempts
 *     the in-flight guard (the user is actively asking us to look,
 *     so a queued duplicate is the right behaviour). Resets the
 *     periodic timer so we don't double-shoot 5 s later.
 *
 * Failure policy: every captured-frame / VLM call is best-effort.
 * On any error (no video, timeout, network, provider 4xx/5xx) the
 * tick logs and exits. We never retry: the next tick will try again
 * naturally.
 */

import { VISION_CONFIG } from "./config";
import { captureFrame } from "./frame-capture";
import { createSttTrigger, type SttTrigger } from "./stt-trigger";
import type { SceneInjector } from "./scene-injector";
import type { VlmProvider } from "./providers/types";
import type { SceneTrigger } from "./types";

export interface ScenePoller {
  start: () => void;
  stop: () => void;
  dispose: () => void;
}

export interface CreateScenePollerOptions {
  provider: VlmProvider;
  injector: SceneInjector;
  getVideoStream: () => MediaStream | null;
  /** Subscribe to completed user transcripts. Returns an
   *  unsubscribe function called on `dispose()`. */
  subscribeUserTranscript: (cb: (text: string) => void) => () => void;
}

export function createScenePoller(opts: CreateScenePollerOptions): ScenePoller {
  let started = false;
  let disposed = false;
  let inFlight = false;
  let activeAbort: AbortController | null = null;
  let periodicTimer: number | null = null;
  let initialTimer: number | null = null;
  let unsubscribeTranscript: (() => void) | null = null;

  const sttTrigger: SttTrigger = createSttTrigger({
    onTrigger: (text, matchedKeyword) => {
      console.info(
        `[vision] STT trigger fired: keyword="${matchedKeyword}", ` +
          `text="${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`,
      );
      // User-initiated triggers preempt the in-flight guard - the user
      // is actively asking us to look. If a periodic call is still
      // running we abort it so the user-targeted description wins.
      if (inFlight && activeAbort) {
        activeAbort.abort();
      }
      // Reset the periodic timer so we don't double-shoot right after.
      schedulePeriodic();
      void runCapture("stt_keyword", text);
    },
  });

  const start = (): void => {
    if (disposed) {
      console.debug("[vision] poller.start ignored: disposed");
      return;
    }
    if (started) {
      console.debug("[vision] poller.start ignored: already started");
      return;
    }
    started = true;
    console.info(
      `[vision] poller starting (initial in ${VISION_CONFIG.initialDelayMs}ms, ` +
        `period ${VISION_CONFIG.intervalMs}ms)`,
    );

    unsubscribeTranscript = opts.subscribeUserTranscript((text) => {
      sttTrigger.feed(text);
    });

    initialTimer = window.setTimeout(() => {
      initialTimer = null;
      void runCapture("initial");
    }, VISION_CONFIG.initialDelayMs);

    schedulePeriodic();
  };

  const stop = (): void => {
    if (!started) return;
    started = false;
    console.info("[vision] poller stopping");
    if (initialTimer !== null) {
      window.clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (periodicTimer !== null) {
      window.clearTimeout(periodicTimer);
      periodicTimer = null;
    }
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    inFlight = false;
    if (unsubscribeTranscript) {
      try {
        unsubscribeTranscript();
      } catch (err) {
        console.warn("[vision] unsubscribeTranscript threw:", err);
      }
      unsubscribeTranscript = null;
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    stop();
    disposed = true;
  };

  function schedulePeriodic(): void {
    if (periodicTimer !== null) {
      window.clearTimeout(periodicTimer);
    }
    periodicTimer = window.setTimeout(() => {
      periodicTimer = null;
      if (!started) return;
      // Periodic ticks honour the in-flight guard - we never queue
      // up parallel VLM calls. The next tick (in `intervalMs`) will
      // pick up the next snapshot if the previous one was still
      // running.
      if (inFlight) {
        console.debug("[vision] periodic tick skipped: previous call still in flight");
        schedulePeriodic();
        return;
      }
      void runCapture("periodic");
    }, VISION_CONFIG.intervalMs);
  }

  async function runCapture(
    trigger: SceneTrigger,
    userHint?: string,
  ): Promise<void> {
    if (!started || disposed) return;

    const stream = opts.getVideoStream();
    if (!stream) {
      console.debug(`[vision] ${trigger} tick: no video stream available, skipping`);
      // Periodic path: re-arm the timer (it was cleared by the
      // STT-trigger reset path). `schedulePeriodic` is idempotent.
      if (trigger === "periodic") schedulePeriodic();
      return;
    }

    const controller = new AbortController();
    activeAbort = controller;
    inFlight = true;
    const startedAt = performance.now();
    try {
      const frame = await captureFrame(stream);
      console.debug(
        `[vision] ${trigger} frame captured (${frame.widthPx}x${frame.heightPx}, ` +
          `~${Math.round(frame.dataUrl.length / 1024)}KB)`,
      );

      const description = await opts.provider.describeScene(frame, {
        trigger,
        userHint,
        abortSignal: controller.signal,
      });

      const elapsed = Math.round(performance.now() - startedAt);
      console.info(
        `[vision] ${trigger} VLM ok in ${elapsed}ms (${description.length} chars)`,
      );

      if (!started || disposed) return;
      opts.injector.inject(description, trigger);

      // Periodic captures shouldn't be immediately followed by an STT
      // capture if the user said the keyword between the frame grab
      // and now. Bump the debounce so the next STT keyword waits.
      if (trigger === "periodic") {
        sttTrigger.resetDebounce();
      }
    } catch (err) {
      const aborted =
        err instanceof DOMException && err.name === "AbortError";
      if (aborted) {
        console.debug(`[vision] ${trigger} tick aborted`);
      } else {
        console.warn(`[vision] ${trigger} tick failed:`, err);
      }
    } finally {
      if (activeAbort === controller) activeAbort = null;
      inFlight = false;
    }
  }

  return { start, stop, dispose };
}
