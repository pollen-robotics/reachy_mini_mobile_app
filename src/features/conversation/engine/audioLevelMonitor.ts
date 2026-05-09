/**
 * Audio-reactive level samplers for the orb visualisation.
 *
 * Two classes, two roles:
 *   - `MicLevelMonitor`  : samples the robot's microphone and writes
 *                          `--audio-level` + `--bar0..--bar4` CSS
 *                          custom properties. Drives the breathing
 *                          ring + 5-band bars on the orb during the
 *                          `listening` / `user-speaking` states.
 *   - `AiLevelMonitor`   : samples the OpenAI output (Reachy's voice)
 *                          and writes `--ai-audio-level`. Drives
 *                          the `ai-speaking` halo + a `waitForSilence`
 *                          helper so the engine can defer state
 *                          transitions until the voice has actually
 *                          stopped, not just until OpenAI says
 *                          `response.done`.
 *
 * Both classes are pure: they take a `target` HTMLElement (the orb
 * root) and an `onLevels` callback as constructor options, and never
 * touch global DOM. Extracted from `conversation-engine.ts` to keep
 * the main file focused on the FSM + orchestration; the audio
 * sampling is self-contained and benefits from being tested in
 * isolation.
 */

import type { ConversationLevelEvent } from './conversation-engine';

interface AudioLevelMonitorOptions {
  /**
   * Lazy getter for the element onto which we write CSS variables
   * at display rate (the orb root in our case). Read on EVERY rAF
   * tick so the binding follows React mount/unmount cycles
   * automatically - the orb element can come and go (tab swaps,
   * iframe handoffs) and the monitor always writes to whichever
   * DOM is currently live, never to a detached node.
   *
   * Returning `null` disables the DOM writes for that frame (the
   * `onLevels` callback is the only output then). The getter MUST
   * be cheap: it runs at ~60 Hz inside the audio level loop.
   */
  getTarget: () => HTMLElement | null;
  /** Optional structured stream of every sample. Fired from inside
   * the same rAF tick that updates the CSS variables, AFTER the
   * smoothing pass. Either side (`user` or `ai`) is non-null per
   * call, never both. */
  onLevels: ((level: ConversationLevelEvent) => void) | null;
}

/* ───────────────────────── Mic-level monitor ───────────────────── */

/**
 * Sample the robot's microphone to a set of CSS custom properties:
 *   --audio-level          smoothed normalized RMS in [0, 1]
 *   --bar0 .. --bar4       five log-spaced frequency-band levels in [0, 1]
 *
 * The overall RMS drives the breathing ring; the per-band levels
 * drive the 5 vertical bars inside the orb during `listening` /
 * `user-speaking`.
 */
export class MicLevelMonitor {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private raf = 0;
  // Time-domain buffer for RMS.
  private timeBuf: Float32Array<ArrayBuffer> | null = null;
  // Frequency-domain buffer for the per-band bars.
  private freqBuf: Uint8Array<ArrayBuffer> | null = null;
  private level = 0;
  private bands = [0, 0, 0, 0, 0];

  // 5 log-spaced bands over the first ~128 bins of a 1024-FFT @ 48 kHz
  // (~47 Hz per bin), covering the bulk of speech energy (~180 Hz to 6 kHz).
  private static readonly BAND_EDGES = [4, 8, 16, 32, 64, 128];
  private static readonly LOG1P_10 = Math.log1p(10);
  private static compress(v: number): number {
    return Math.log1p(v * 10) / MicLevelMonitor.LOG1P_10;
  }

  constructor(private readonly options: AudioLevelMonitorOptions) {}

  start(track: MediaStreamTrack): void {
    this.stop();
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);

    this.ctx = ctx;
    this.source = src;
    this.analyser = analyser;
    this.timeBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    this.freqBuf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));

    // Style target is queried via getter on each tick (NOT captured
    // here) so a panel remount that swaps the orb DOM transparently
    // re-targets the writes to the fresh element. Writing to :root
    // is intentionally NOT a fallback - it leaks across HMR /
    // StrictMode and made stale levels survive remounts.
    const getTarget = this.options.getTarget;
    const onLevels = this.options.onLevels;
    const bandsForCallback: [number, number, number, number, number] = [
      0, 0, 0, 0, 0,
    ];

    const tick = () => {
      const an = this.analyser;
      const tbuf = this.timeBuf;
      const fbuf = this.freqBuf;
      if (!an || !tbuf || !fbuf) return;

      // Re-read the current target on every frame. Cheap (one
      // function call, one .style access on hit) and what makes
      // the binding remount-proof.
      const targetStyle = getTarget()?.style ?? null;

      an.getFloatTimeDomainData(tbuf);
      let sum = 0;
      for (let i = 0; i < tbuf.length; i++) sum += tbuf[i] * tbuf[i];
      const rms = Math.sqrt(sum / tbuf.length);
      const boosted = Math.min(1, Math.pow(rms * 6, 0.7));
      const levelAttack = boosted > this.level ? 0.55 : 0.12;
      this.level += (boosted - this.level) * levelAttack;
      targetStyle?.setProperty('--audio-level', this.level.toFixed(3));

      an.getByteFrequencyData(fbuf);
      const edges = MicLevelMonitor.BAND_EDGES;
      for (let b = 0; b < 5; b++) {
        const lo = edges[b];
        const hi = edges[b + 1];
        let bandSum = 0;
        for (let j = lo; j < hi; j++) bandSum += fbuf[j];
        const raw = MicLevelMonitor.compress(bandSum / (hi - lo) / 255);
        const bandAttack = raw > this.bands[b] ? 0.35 : 0.12;
        this.bands[b] += (raw - this.bands[b]) * bandAttack;
        const clamped = Math.min(1, this.bands[b]);
        bandsForCallback[b] = clamped;
        targetStyle?.setProperty(`--bar${b}`, clamped.toFixed(3));
      }

      if (onLevels) {
        try {
          onLevels({
            user: this.level,
            ai: null,
            bands: bandsForCallback,
          });
        } catch (err) {
          console.warn('[mic-level] onLevels threw:', err);
        }
      }

      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    try {
      this.source?.disconnect();
      this.analyser?.disconnect();
      this.ctx?.close();
    } catch {
      // ignored
    }
    this.ctx = null;
    this.source = null;
    this.analyser = null;
    this.timeBuf = null;
    this.freqBuf = null;
    this.level = 0;
    this.bands = [0, 0, 0, 0, 0];
    // Reset CSS vars on the *current* target (if any). The element
    // we wrote to over the lifetime of `start()` may have been
    // unmounted in the meantime, in which case there's nothing to
    // reset and we silently skip.
    const currentTarget = this.options.getTarget();
    if (currentTarget) {
      const s = currentTarget.style;
      s.setProperty('--audio-level', '0');
      for (let b = 0; b < 5; b++) s.setProperty(`--bar${b}`, '0');
    }
    if (this.options.onLevels) {
      try {
        this.options.onLevels({ user: 0, ai: null, bands: [0, 0, 0, 0, 0] });
      } catch {
        // ignored
      }
    }
  }

  /**
   * Wake the AudioContext back up after the tab came out of background.
   * Safari + iOS in particular suspend contexts while hidden and don't
   * resume them on their own.
   */
  resumeAudio(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch((err) => {
        console.warn('[mic-level] audioCtx resume failed:', err);
      });
    }
  }
}

/* ───────────────────────── AI-level monitor ───────────────────── */

/**
 * Sample the OpenAI output (Reachy's voice) to a single CSS custom
 * property `--ai-audio-level` in [0, 1]. Drives the ai-speaking halo
 * (core scale + outer-ring ripple) in real time, so the orb pulses on
 * every syllable instead of running a fixed-timer animation.
 *
 * Also tracks when the audio goes silent for long enough that we can
 * confidently exit the ai-speaking state. The OpenAI `response.done`
 * event fires the moment the model finishes *generating*, but the
 * already-buffered audio may still be playing out of the speakers for
 * another few hundred milliseconds. `waitForSilence()` lets callers
 * defer the state transition until the voice has actually stopped.
 */
export class AiLevelMonitor {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private raf = 0;
  private timeBuf: Float32Array<ArrayBuffer> | null = null;
  private level = 0;
  // Monotonic timestamp (performance.now) of the last tick where the
  // smoothed RMS was above the silence threshold.
  private lastActiveTs = 0;

  // A queued "wait for silence" callback. Fires after the monitor has
  // observed at least `quietMs` of continuous silence.
  private silenceWait: {
    quietMs: number;
    cb: () => void;
    maxWaitTimer: number | null;
  } | null = null;

  // Linear RMS threshold below which we consider the track silent.
  // ≈ -44 dBFS. Intentionally low so that soft syllables, trailing
  // vowels and breath sounds still register as "active": users were
  // seeing the UI snap back to `listening` while Reachy was still
  // talking, which was caused by brief inter-word dips crossing a
  // too-aggressive threshold.
  private static readonly SILENCE_THRESHOLD = 0.006;

  constructor(private readonly options: AudioLevelMonitorOptions) {}

  start(track: MediaStreamTrack): void {
    this.stop();
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);

    this.ctx = ctx;
    this.source = src;
    this.analyser = analyser;
    this.timeBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    this.lastActiveTs = performance.now();

    // See `MicLevelMonitor.start()` for the rationale: lazy DOM
    // lookup per tick keeps the binding remount-proof.
    const getTarget = this.options.getTarget;
    const onLevels = this.options.onLevels;

    const tick = () => {
      const an = this.analyser;
      const buf = this.timeBuf;
      if (!an || !buf) return;

      const targetStyle = getTarget()?.style ?? null;

      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);

      const boosted = Math.min(1, Math.pow(rms * 6, 0.7));
      const levelAttack = boosted > this.level ? 0.55 : 0.12;
      this.level += (boosted - this.level) * levelAttack;
      targetStyle?.setProperty('--ai-audio-level', this.level.toFixed(3));

      if (onLevels) {
        try {
          onLevels({ user: null, ai: this.level, bands: null });
        } catch (err) {
          console.warn('[ai-level] onLevels threw:', err);
        }
      }

      const now = performance.now();
      if (rms > AiLevelMonitor.SILENCE_THRESHOLD) {
        this.lastActiveTs = now;
      } else if (this.silenceWait) {
        const quietFor = now - this.lastActiveTs;
        if (quietFor >= this.silenceWait.quietMs) {
          const { cb, maxWaitTimer } = this.silenceWait;
          this.silenceWait = null;
          if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
          try {
            cb();
          } catch (err) {
            console.warn('[ai-level] silence callback threw:', err);
          }
        }
      }

      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cancelSilenceWait();
    try {
      this.source?.disconnect();
      this.analyser?.disconnect();
      this.ctx?.close();
    } catch {
      // ignored
    }
    this.ctx = null;
    this.source = null;
    this.analyser = null;
    this.timeBuf = null;
    this.level = 0;
    // Reset the CSS var on the *current* target. May be null if the
    // panel unmounted while we were running - silently skip.
    this.options.getTarget()?.style.setProperty('--ai-audio-level', '0');
    if (this.options.onLevels) {
      try {
        this.options.onLevels({ user: null, ai: 0, bands: null });
      } catch {
        // ignored
      }
    }
  }

  resumeAudio(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch((err) => {
        console.warn('[ai-level] audioCtx resume failed:', err);
      });
    }
  }

  /**
   * Call `cb` once the track has been silent for at least `quietMs`.
   * Replaces any previous pending wait. `maxWaitMs` is a safety
   * fallback: if the monitor never sees silence (e.g. music, a stuck
   * noise floor), we fire the callback anyway so the UI doesn't hang.
   */
  waitForSilence(quietMs: number, cb: () => void, maxWaitMs = 8000): void {
    this.cancelSilenceWait();
    const maxWaitTimer = window.setTimeout(() => {
      if (this.silenceWait?.cb === cb) {
        this.silenceWait = null;
        try {
          cb();
        } catch (err) {
          console.warn('[ai-level] max-wait callback threw:', err);
        }
      }
    }, maxWaitMs);
    this.silenceWait = { quietMs, cb, maxWaitTimer };
  }

  /** Drop any pending waitForSilence without firing the callback. */
  cancelSilenceWait(): void {
    if (!this.silenceWait) return;
    if (this.silenceWait.maxWaitTimer !== null) {
      clearTimeout(this.silenceWait.maxWaitTimer);
    }
    this.silenceWait = null;
  }
}
