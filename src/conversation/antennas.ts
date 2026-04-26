/**
 * Antennas oscillator - mirrors the `BreathingMove` antenna behaviour from
 * `reachy_mini_conversation_app/moves.py`: a gentle sinusoid in opposition
 * (right ↔ −left) at ~0.5 Hz with a ±15° amplitude. The two ears "breathe"
 * asymmetrically which makes an idle robot feel alive.
 *
 * When the user starts speaking we freeze the antennas on their current
 * position (just like the Python `set_listening(True)` path), and smoothly
 * blend back into the oscillation once they stop.
 */

import { createUnthrottledInterval } from "./unthrottled-interval";

const FREQ_HZ = 0.5;
const AMPLITUDE_DEG = 15;
const BLEND_MS = 400; // time to smoothly ramp back after a freeze

export interface AntennasOscillatorOptions {
  onAntennas: (right: number, left: number) => void;
  /** Update rate in Hz. 30 is plenty for smooth motion. Defaults to 30. */
  updateHz?: number;
}

export class AntennasOscillator {
  private readonly onAntennas: (right: number, left: number) => void;
  private readonly periodMs: number;

  private timer: { clear: () => void } | null = null;
  private t = 0;
  private frozen = false;
  private frozenRight = 0;
  private frozenLeft = 0;
  // 0..1 crossfader between frozen pose and live oscillation.
  private blend = 1;

  constructor(options: AntennasOscillatorOptions) {
    this.onAntennas = options.onAntennas;
    this.periodMs = 1000 / (options.updateHz ?? 30);
  }

  start(): void {
    if (this.timer !== null) return;
    this.t = 0;
    this.blend = 1;
    this.frozen = false;
    // Worker-backed interval so the oscillation keeps ticking at 30Hz even
    // when the app window loses focus (plain setInterval gets clamped to
    // ~1Hz, which makes the ears jerk).
    this.timer = createUnthrottledInterval(() => this.tick(), this.periodMs);
  }

  stop(): void {
    if (this.timer !== null) {
      this.timer.clear();
      this.timer = null;
    }
    // Return to neutral so the ears don't stay stuck at a random angle.
    this.onAntennas(0, 0);
  }

  /**
   * Freeze the antennas on their current position. Used when the user is
   * speaking: the robot "listens attentively" instead of keeping its
   * idle animation.
   */
  freeze(): void {
    if (this.frozen) return;
    this.frozen = true;
    // Snapshot the current oscillation output so the freeze is seamless.
    const { right, left } = this.currentOscillation();
    this.frozenRight = right;
    this.frozenLeft = left;
    this.blend = 0; // fully on the frozen values
  }

  /**
   * Release the freeze; antennas ramp back into the oscillation over
   * ~BLEND_MS ms.
   */
  resume(): void {
    if (!this.frozen) return;
    this.frozen = false;
    // `blend` will rise back to 1 via tick().
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private tick(): void {
    this.t += this.periodMs / 1000;

    // Update blend towards its target (0 when frozen, 1 when live).
    const target = this.frozen ? 0 : 1;
    const step = this.periodMs / BLEND_MS;
    if (this.blend < target) this.blend = Math.min(1, this.blend + step);
    else if (this.blend > target) this.blend = Math.max(0, this.blend - step);

    const { right: liveR, left: liveL } = this.currentOscillation();
    const right = liveR * this.blend + this.frozenRight * (1 - this.blend);
    const left = liveL * this.blend + this.frozenLeft * (1 - this.blend);

    this.onAntennas(right, left);
  }

  private currentOscillation(): { right: number; left: number } {
    const phase = 2 * Math.PI * FREQ_HZ * this.t;
    const right = AMPLITUDE_DEG * Math.sin(phase);
    // Opposition: when right antenna goes "up", left goes "down".
    const left = -AMPLITUDE_DEG * Math.sin(phase);
    return { right, left };
  }
}
