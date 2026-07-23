/**
 * Live microphone analysis off the robot's inbound WebRTC audio track.
 *
 * The conversation engine's own mic monitor only runs while a
 * conversation is active, so during the wizard we build a private
 * AnalyserNode straight off the peer connection.
 *
 * We expose two derived signals, both throttled to ~25 Hz so the React
 * tree doesn't churn on every audio frame:
 *
 *  - `level`    : the raw microphone loudness (time-domain RMS) for the bars,
 *                 lightly smoothed for display only. Deliberately NOT noise-
 *                 gated - the bars just show what the mic produces so they
 *                 react to any sound directly, independent of the tap detector.
 *  - `activity` : an onset score (spectral flux) that spikes on taps and
 *                 stays high during scratching, but reads ~0 on any steady
 *                 sound. This is what the step uses to detect real input
 *                 instead of trusting raw amplitude.
 *
 * Both are gated by a self-calibrating z-score: we model ambient mean +
 * variance (updated only on quiet frames) and react only to values several
 * standard deviations above it, so it adapts to any mic/room automatically.
 */

import { useEffect, useState } from 'react';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';

// A high-pass filter in front of the analyser kills low-frequency rumble /
// mains hum / DC offset that otherwise leaks constant energy into every bin.
// This is the single biggest win against "the bars twitch when the room is
// silent" (standard advice for browser VAD).
const HIGHPASS_HZ = 120;

// --- Statistical noise gate (self-calibrating) ----------------------------
// Instead of guessing absolute thresholds, we model the ambient noise of BOTH
// signals as a running mean + variance and only react to values that sit
// several standard deviations above that model (a z-score gate). Crucially the
// noise model is updated ONLY on frames judged quiet, so a real sound can't
// slowly inflate the baseline and desensitise the gate. This adapts to any
// mic / room level on its own - no magic numbers tied to a specific device.
const LEVEL_SIGMA = 3; // rms must beat the noise mean by this many std devs
const FLUX_SIGMA = 2.5; // flux must beat its noise mean by this many std devs
const NOISE_ADAPT = 0.03; // EMA rate of the noise model (quiet frames only)
const WARMUP_FRAMES = 15; // ~0.6 s seeding the model at mount (assumed quiet)
// Floors on the estimated std so a near-constant signal (variance -> 0) can't
// make the z-score explode and fire on microscopic wiggles.
const MIN_LEVEL_STD = 0.01;
const MIN_FLUX_STD = 0.001;
// How many sigmas ABOVE the flux threshold map to a full-scale (1.0) activity
// output. Small span = ramps up fast once past the threshold (more responsive).
const FLUX_SPAN = 4;
// Raw-loudness gain for the bars: scales the time-domain RMS amplitude into the
// 0..1 bar range. The bars show what the mic produces directly (no noise gate),
// so this is a pure display scale - bump it if the bars read low.
const LEVEL_GAIN = 4;
const LEVEL_SMOOTHING = 0.4; // display-only smoothing so the bars aren't jittery

export function useRobotMicLevel(
  session: RobotSessionHandle,
): { level: number; activity: number; isActive: boolean } {
  const [level, setLevel] = useState(0);
  const [activity, setActivity] = useState(0);
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    const robot = session.getRobot();
    const pc = robot?._pc ?? null;
    if (!pc) return;

    const receiver = pc
      .getReceivers()
      .find(r => r.track?.kind === 'audio' && r.track.readyState === 'live');
    const track = receiver?.track ?? null;
    if (!track) return;

    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = HIGHPASS_HZ;
    highpass.Q.value = 0.7;
    const analyser = ctx.createAnalyser();
    // 512-point FFT (256 bins) gives spectral flux a bit more to chew on, and
    // low temporal smoothing lets transients (taps) actually show up frame to
    // frame instead of being averaged away.
    analyser.fftSize = 512;
    // Low temporal smoothing so each tap stays a sharp, isolated transient
    // instead of being averaged across frames (which flattened the flux peak
    // and made rapid taps blur together).
    analyser.smoothingTimeConstant = 0.15;
    source.connect(highpass);
    highpass.connect(analyser);
    const bins = analyser.frequencyBinCount;
    const data = new Uint8Array(bins);
    const prev = new Float32Array(bins);
    // Time-domain buffer for the raw waveform RMS that drives the bars.
    const timeData = new Uint8Array(analyser.fftSize);
    void ctx.resume().catch(() => {});
    setIsActive(true);

    // Running noise model (mean + variance) for both signals.
    let levelMean = 0;
    let levelVar = 0;
    let fluxMean = 0;
    let fluxVar = 0;
    let frame = 0;
    let dispLevel = 0; // smoothed gated level for the bars

    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 40) return;
      last = t;

      analyser.getByteFrequencyData(data);

      // Raw waveform loudness for the bars: time-domain RMS around the 128
      // midpoint, ~0 in silence and rising with any sound. Independent of the
      // z-score noise gate below (which only drives the tap detector).
      analyser.getByteTimeDomainData(timeData);
      let ampSum = 0;
      for (let i = 0; i < timeData.length; i += 1) {
        const d = (timeData[i] - 128) / 128;
        ampSum += d * d;
      }
      const amp = Math.sqrt(ampSum / timeData.length);

      // Single pass: RMS energy (loudness) + spectral flux (onset strength).
      let sum = 0;
      let flux = 0;
      for (let i = 0; i < bins; i += 1) {
        const v = data[i];
        sum += v * v;
        const d = v - prev[i];
        if (d > 0) flux += d; // only rising bins => energy appearing = onset
        prev[i] = v;
      }
      const rms = Math.sqrt(sum / bins) / 255;
      flux /= bins * 255; // normalise to a roughly 0..1 scale

      // z-scores against the current ambient model.
      const levelStd = Math.max(Math.sqrt(levelVar), MIN_LEVEL_STD);
      const fluxStd = Math.max(Math.sqrt(fluxVar), MIN_FLUX_STD);
      const zLevel = (rms - levelMean) / levelStd;
      const zFlux = (flux - fluxMean) / fluxStd;

      // A frame is "quiet" (i.e. safe to fold into the noise model) unless
      // either signal is clearly above its ambient distribution.
      const warming = frame < WARMUP_FRAMES;
      const quiet = zLevel < LEVEL_SIGMA && zFlux < FLUX_SIGMA;
      if (warming || quiet) {
        const dL = rms - levelMean;
        levelMean += dL * NOISE_ADAPT;
        levelVar += (dL * dL - levelVar) * NOISE_ADAPT;
        const dF = flux - fluxMean;
        fluxMean += dF * NOISE_ADAPT;
        fluxVar += (dF * dF - fluxVar) * NOISE_ADAPT;
      }
      frame += 1;

      // Bars = raw mic loudness, scaled to 0..1. No noise gate / z-score: they
      // just track what the mic produces. Fast attack / slower release so a
      // sound jumps in immediately then eases down; the smoothing is
      // display-only (keeps the bars from strobing frame to frame).
      const targetLevel = Math.min(1, amp * LEVEL_GAIN);
      dispLevel += (targetLevel - dispLevel) * (targetLevel > dispLevel ? 0.8 : LEVEL_SMOOTHING);
      setLevel(dispLevel);

      // Detection signal: onset strength past its sigma threshold. ~0 on any
      // steady sound (which is folded into the model), spikes on taps/scratch.
      setActivity(warming ? 0 : Math.min(1, Math.max(0, zFlux - FLUX_SIGMA) / FLUX_SPAN));
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      setIsActive(false);
      try {
        source.disconnect();
        highpass.disconnect();
      } catch {
        // ignore
      }
      void ctx.close().catch(() => {});
    };
  }, [session]);

  return { level, activity, isActive };
}
