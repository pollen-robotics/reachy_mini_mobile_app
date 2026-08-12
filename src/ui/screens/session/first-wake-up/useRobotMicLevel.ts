/**
 * Live microphone loudness off the robot's inbound WebRTC audio track.
 *
 * The conversation engine's own mic monitor only runs while a
 * conversation is active, so during the wizard we build a private
 * AnalyserNode straight off the peer connection. A 500 ms watchdog owns
 * the binding: it waits for the audio track when it isn't live yet at
 * mount, and rebuilds the graph when an auto re-dial replaces the peer
 * connection (`isActive` drops while unbound, so the step's status can
 * tell the truth instead of listening to a dead track).
 *
 * Detection is deliberately simple - one signal, one threshold:
 *
 *  - `level` : raw microphone loudness (time-domain RMS), lightly smoothed
 *              for the bars. What the user sees.
 *  - `loud`  : true while the loudness clearly exceeds the ambient
 *              baseline. What the step counts. Same underlying signal as
 *              the bars, so "the bars are hot" and "it counts" agree.
 *
 * The ambient baseline is a slow EMA updated only while NOT loud, so a
 * scratch can't inflate it and desensitise the check. Hysteresis (enter
 * high / exit low) plus a short hangover keep `loud` from flickering and
 * let discrete taps register as a meaningful chunk of time instead of a
 * couple of frames.
 */

import { useEffect, useState } from 'react';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { getPlatform } from '@/shared/platform';

// A high-pass filter in front of the analyser kills low-frequency rumble /
// mains hum / DC offset that otherwise leaks constant energy into silence.
const HIGHPASS_HZ = 120;

// ─── Display (the bars) ─────────────────────────────────────────────────────
/** Scales the raw RMS amplitude into the 0..1 bar range (display only). */
const LEVEL_GAIN = 4;
/** Display-only smoothing so the bars aren't jittery (release side). */
const LEVEL_SMOOTHING = 0.4;

// ─── Detection (`loud`) ─────────────────────────────────────────────────────
/** EMA rate of the ambient baseline (quiet frames only, ~25 Hz ticks). */
const AMBIENT_ADAPT = 0.05;
/** Frames spent seeding the baseline at attach (~0.4 s, assumed quiet). */
const WARMUP_FRAMES = 10;
/** Enter `loud` above ambient*factor + floor; the floor keeps a dead-quiet
 *  room (ambient ~0) from firing on microscopic wiggles. */
const LOUD_ENTER_FACTOR = 4;
const LOUD_EXIT_FACTOR = 2.5;
const LOUD_FLOOR = 0.015;
/** `loud` lingers this long after the last loud frame, so a short tap
 *  counts as a meaningful chunk of time (~2 taps fill the step). */
const LOUD_HANGOVER_MS = 250;

export function useRobotMicLevel(
  session: RobotSessionHandle,
): { level: number; loud: boolean; isActive: boolean } {
  const [level, setLevel] = useState(0);
  const [loud, setLoud] = useState(false);
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    const robot = session.getRobot();
    if (!robot) return;

    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const findLiveTrack = (pc: RTCPeerConnection | null): MediaStreamTrack | null =>
      pc
        ?.getReceivers()
        .find(r => r.track?.kind === 'audio' && r.track.readyState === 'live')?.track ?? null;

    // What the analyser is currently wired to. Auto-reconnect re-dials
    // REPLACE `robot.peerConnection` (SDK contract: re-read it on every
    // use), so these are re-checked by the watchdog below rather than
    // captured once for the lifetime of the hook.
    let attachedPc: RTCPeerConnection | null = null;
    let attachedTrack: MediaStreamTrack | null = null;
    let teardownGraph: (() => void) | null = null;
    let disposed = false;

    const buildGraph = (track: MediaStreamTrack): (() => void) => {
      const ctx = new AudioCtx();
      // Android-only: the WebView feeds a remote WebRTC track into Web
      // Audio only if the track is ALSO attached to a playing media
      // element (crbug.com/121673). Without this muted pump the analyser
      // reads flat silence, so the tap never registers and the step sits
      // there looking connected. The conversation path has its own pump
      // (`PcmInputStreamer`), which is why talking to the robot works
      // while this step doesn't - the wizard runs with no conversation,
      // so nothing else is holding the track open.
      let pump: HTMLAudioElement | null = null;
      if (getPlatform() === 'android') {
        pump = document.createElement('audio');
        pump.autoplay = true;
        pump.muted = true;
        pump.srcObject = new MediaStream([track]);
        document.body.appendChild(pump);
      }
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = HIGHPASS_HZ;
      highpass.Q.value = 0.7;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(highpass);
      highpass.connect(analyser);
      const timeData = new Uint8Array(analyser.fftSize);
      void ctx.resume().catch(() => {});
      setIsActive(true);

      // Fresh graph = fresh ambient baseline (re-seeded by the warm-up): a
      // new transport can sit at a different level.
      let ambient = 0;
      let frame = 0;
      let isLoud = false;
      let lastLoudAt = 0;
      let dispLevel = 0;

      let raf = 0;
      let last = 0;
      const tick = (t: number) => {
        raf = requestAnimationFrame(tick);
        if (t - last < 40) return; // ~25 Hz so the React tree doesn't churn
        last = t;

        // Raw waveform loudness: time-domain RMS around the 128 midpoint,
        // ~0 in silence and rising with any sound.
        analyser.getByteTimeDomainData(timeData);
        let ampSum = 0;
        for (let i = 0; i < timeData.length; i += 1) {
          const d = (timeData[i] - 128) / 128;
          ampSum += d * d;
        }
        const amp = Math.sqrt(ampSum / timeData.length);

        // Bars: fast attack / slower release, display-only smoothing.
        const targetLevel = Math.min(1, amp * LEVEL_GAIN);
        dispLevel += (targetLevel - dispLevel) * (targetLevel > dispLevel ? 0.8 : LEVEL_SMOOTHING);
        setLevel(dispLevel);

        // Loud gate: hysteresis around the ambient baseline. The baseline
        // only adapts while quiet (and during the warm-up), so a scratch
        // can't drag it up and mute the very gesture we're detecting.
        const warming = frame < WARMUP_FRAMES;
        frame += 1;
        const enter = ambient * LOUD_ENTER_FACTOR + LOUD_FLOOR;
        const exit = ambient * LOUD_EXIT_FACTOR + LOUD_FLOOR * 0.6;
        const above = isLoud ? amp > exit : amp > enter;
        if (warming || !above) ambient += (amp - ambient) * AMBIENT_ADAPT;

        if (!warming && above) {
          isLoud = true;
          lastLoudAt = t;
        } else if (isLoud && t - lastLoudAt > LOUD_HANGOVER_MS) {
          isLoud = false;
        }
        setLoud(isLoud);
      };
      raf = requestAnimationFrame(tick);

      return () => {
        cancelAnimationFrame(raf);
        setIsActive(false);
        setLevel(0);
        setLoud(false);
        try {
          source.disconnect();
          highpass.disconnect();
          if (pump) {
            pump.srcObject = null;
            pump.remove();
            pump = null;
          }
        } catch {
          // ignore
        }
        void ctx.close().catch(() => {});
      };
    };

    const detach = () => {
      teardownGraph?.();
      teardownGraph = null;
      attachedPc = null;
      attachedTrack = null;
    };

    // Watchdog: (re)binds the analyser to whatever transport is currently
    // live. Covers both the "track not live yet at mount" race (keep
    // polling until it appears - the step shows "Connecting to the
    // microphone…" meanwhile) and the auto re-dial case (fresh PC replaces
    // the one we were wired to, whose track never comes back): tear the
    // dead graph down so the UI stops claiming to listen, then re-attach
    // to the new track when the re-dial lands. A 500 ms identity check is
    // cheap and avoids coupling to the SDK's reconnect event names.
    const tryAttach = () => {
      const pc = robot.peerConnection;
      const stale =
        attachedPc != null && (pc !== attachedPc || attachedTrack?.readyState !== 'live');
      if (stale) detach();
      if (!attachedPc && pc) {
        const track = findLiveTrack(pc);
        if (track) {
          attachedPc = pc;
          attachedTrack = track;
          teardownGraph = buildGraph(track);
        }
      }
    };

    tryAttach();
    const watchdog = window.setInterval(() => {
      if (!disposed) tryAttach();
    }, 500);

    return () => {
      disposed = true;
      window.clearInterval(watchdog);
      detach();
    };
  }, [session]);

  return { level, loud, isActive };
}
