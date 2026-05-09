/**
 * Head wobble generator - JS port of the Python
 * `reachy_mini_conversation_app/audio/speech_tapper.py` + `head_wobbler.py`.
 *
 * Purpose: take the assistant's outgoing voice (the audio OpenAI plays back
 * through the robot) and drive small, organic head sways + nods in sync with
 * the speech, so Reachy "comes alive" while talking.
 *
 * The Python version sampled raw PCM base64 deltas over the OpenAI WebSocket
 * API; we instead hook a Web Audio `AnalyserNode` to the remote
 * `MediaStreamTrack` (which is how audio reaches us in WebRTC mode). Both
 * yield the same loudness envelope we need to modulate the sine oscillators.
 *
 * The SDK only exposes rotational `setHeadPose(roll, pitch, yaw)` in degrees,
 * so we drop the small (±mm-range) translations from the original Python
 * pipeline - they're a cherry-on-top that isn't reachable through the public
 * JS API anyway.
 */

import { createUnthrottledInterval } from "./unthrottled-interval";

// ─── Constants ported from speech_tapper.py ─────────────────────────────
// Frame / hop timing. Hop drives how often we update offsets.
const HOP_MS = 50; // produce one pose target every 50ms (20Hz)
const FRAME_MS = 20; // RMS window in ms

// Loudness mapping: RMS in dBFS is remapped to [0..1] with a slight gamma.
const SWAY_DB_LOW = -46;
const SWAY_DB_HIGH = -18;
const SWAY_DB_GAMMA = 0.9;
const SWAY_MASTER = 1.5;
const SENS_DB_OFFSET = 4;

// Hysteretic VAD thresholds on the sliding-frame dBFS envelope.
const VAD_DB_ON = -35;
const VAD_DB_OFF = -45;
// Attack / release for the 0→1 envelope follower that multiplies the sway.
const ENV_FOLLOW_GAIN = 0.65;

// Sinusoid frequencies (Hz) + peak amplitudes (degrees).
// All three axes use independent initial phases so the motion doesn't feel
// mechanical when they align.
const SWAY_F_PITCH = 2.2;
const SWAY_A_PITCH_DEG = 4.5;

const SWAY_F_YAW = 0.6;
const SWAY_A_YAW_DEG = 7.5;

const SWAY_F_ROLL = 1.3;
const SWAY_A_ROLL_DEG = 2.25;

// Deliberate delay between the audio we analyse and the matching head
// motion. A touch of latency makes the motion feel slaved to the voice
// (reactive, not predictive). Matches `MOVEMENT_LATENCY_S = 0.2` in Python.
const MOVEMENT_LATENCY_S = 0.2;

// ─── Types ──────────────────────────────────────────────────────────────

export interface HeadOffsetsDeg {
  roll: number;
  pitch: number;
  yaw: number;
}

export interface HeadWobblerOptions {
  track: MediaStreamTrack;
  onOffsets: (offsets: HeadOffsetsDeg) => void;
  /**
   * Master scalar applied on top of the per-axis amplitudes. Lets callers
   * tone the whole effect down without recompiling constants. Defaults to 1.
   */
  gain?: number;
}

// ─── Implementation ─────────────────────────────────────────────────────

/**
 * Consumes a `MediaStreamTrack` (assistant voice) and emits head rotation
 * offsets in degrees every hop (~50 ms), smoothly ramping in and out with
 * the speech envelope.
 *
 * Call `start()` to begin, `stop()` to tear down, `reset()` to zero the
 * internal sway state (useful when the user barges in on the assistant).
 */
export class HeadWobbler {
  private readonly track: MediaStreamTrack;
  private readonly onOffsets: (offsets: HeadOffsetsDeg) => void;
  private readonly gain: number;

  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private frameBuf: Float32Array<ArrayBuffer> | null = null;

  private timer: { clear: () => void } | null = null;

  // Sway state
  private t = 0; // seconds since start() for the sine oscillators
  private swayEnv = 0; // 0..1 envelope follower on VAD-on/off
  private vadOn = false;
  private pendingOffsets: HeadOffsetsDeg[] = [];

  // Per-axis phase offsets so the three sines don't line up on the downbeat.
  private readonly phasePitch = 0.13 * Math.PI;
  private readonly phaseYaw = 0.48 * Math.PI;
  private readonly phaseRoll = 1.21 * Math.PI;

  constructor(options: HeadWobblerOptions) {
    this.track = options.track;
    this.onOffsets = options.onOffsets;
    this.gain = options.gain ?? 1.0;
  }

  start(): void {
    if (this.audioCtx) return; // already running

    // A dedicated AudioContext keeps the robot mic path untouched. We don't
    // need the browser to actually play this back (the audio is also piped
    // straight to the robot speaker via replaceTrack), we just want samples.
    const ctx = new AudioContext();
    const sourceStream = new MediaStream([this.track]);
    const source = ctx.createMediaStreamSource(sourceStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);

    const frameSamples = Math.max(
      128,
      Math.round((ctx.sampleRate * FRAME_MS) / 1000),
    );
    this.frameBuf = new Float32Array(new ArrayBuffer(frameSamples * 4));

    this.audioCtx = ctx;
    this.sourceNode = source;
    this.analyser = analyser;

    // Worker-backed interval so the 20Hz tick keeps running when the
    // window loses focus. Plain `setInterval` gets throttled to ~1Hz by
    // WebKit/Chromium on unfocused windows, which turns the smooth head
    // sway into visible jerks whenever the user switches app.
    this.timer = createUnthrottledInterval(() => this.tick(), HOP_MS);
  }

  stop(): void {
    this.stopWithoutFinalFrame();
    // Return to neutral head pose on teardown so the robot doesn't freeze
    // mid-motion.
    this.onOffsets({ roll: 0, pitch: 0, yaw: 0 });
  }

  /**
   * Same as `stop()` minus the final neutral frame. Used by callers
   * that want to take over the landing themselves (e.g. a smooth
   * easing back to neutral over a few hundred ms instead of an
   * instant snap).
   */
  stopWithoutFinalFrame(): void {
    if (this.timer !== null) {
      this.timer.clear();
      this.timer = null;
    }
    try {
      this.sourceNode?.disconnect();
      this.analyser?.disconnect();
      this.audioCtx?.close();
    } catch {
      // ignored
    }
    this.sourceNode = null;
    this.analyser = null;
    this.audioCtx = null;
    this.frameBuf = null;
    this.pendingOffsets = [];
  }

  /**
   * Re-activate the internal AudioContext after a visibility change. Some
   * browsers (Safari, iOS) suspend contexts when the tab is hidden and
   * don't auto-resume; without this call the RMS meter reads zero forever
   * after the first background trip.
   */
  resumeAudio(): void {
    const ctx = this.audioCtx;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch((err) => {
        console.warn("[head-wobbler] audioCtx resume failed:", err);
      });
    }
  }

  /**
   * Reset the sway envelope + latency queue. Call this when the user starts
   * speaking while the assistant is still talking: we want motion to fade
   * out smoothly instead of holding the last sine value.
   */
  reset(): void {
    this.swayEnv = 0;
    this.vadOn = false;
    this.pendingOffsets = [];
    this.onOffsets({ roll: 0, pitch: 0, yaw: 0 });
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private tick(): void {
    if (!this.analyser || !this.frameBuf) return;

    // 1. Measure current loudness in dBFS on the most recent ~20 ms.
    this.analyser.getFloatTimeDomainData(this.frameBuf);
    const db = rmsDbfs(this.frameBuf) + SENS_DB_OFFSET;

    // 2. Hysteretic VAD on the dB envelope.
    if (this.vadOn) {
      if (db < VAD_DB_OFF) this.vadOn = false;
    } else {
      if (db > VAD_DB_ON) this.vadOn = true;
    }

    // 3. Smooth 0..1 envelope the sines are modulated by.
    const target = this.vadOn ? 1 : 0;
    this.swayEnv += (target - this.swayEnv) * ENV_FOLLOW_GAIN;

    // 4. Loudness gain - how much of the max amplitude we reach on this hop.
    const loud = loudnessGain(db);

    // 5. Time-evolve the oscillators.
    this.t += HOP_MS / 1000;
    const twoPiT = 2 * Math.PI * this.t;
    const mod = loud * this.swayEnv * this.gain * SWAY_MASTER;

    const pitchDeg =
      SWAY_A_PITCH_DEG * mod * Math.sin(twoPiT * SWAY_F_PITCH + this.phasePitch);
    const yawDeg =
      SWAY_A_YAW_DEG * mod * Math.sin(twoPiT * SWAY_F_YAW + this.phaseYaw);
    const rollDeg =
      SWAY_A_ROLL_DEG * mod * Math.sin(twoPiT * SWAY_F_ROLL + this.phaseRoll);

    // 6. Enqueue with latency, then emit the oldest ready sample.
    this.pendingOffsets.push({ roll: rollDeg, pitch: pitchDeg, yaw: yawDeg });
    const maxQueue = Math.ceil((MOVEMENT_LATENCY_S * 1000) / HOP_MS);
    while (this.pendingOffsets.length > maxQueue) {
      const next = this.pendingOffsets.shift();
      if (next) this.onOffsets(next);
    }
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────────

function rmsDbfs(samples: Float32Array<ArrayBuffer>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sum += s * s;
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  if (rms <= 1e-8) return -120;
  return 20 * Math.log10(rms);
}

function loudnessGain(db: number): number {
  // Linear remap [SWAY_DB_LOW..SWAY_DB_HIGH] -> [0..1] with a gamma.
  const norm = (db - SWAY_DB_LOW) / (SWAY_DB_HIGH - SWAY_DB_LOW);
  const clamped = Math.max(0, Math.min(1, norm));
  return Math.pow(clamped, SWAY_DB_GAMMA);
}
