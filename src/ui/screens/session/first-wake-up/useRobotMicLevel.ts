/**
 * Live microphone level off the robot's inbound WebRTC audio track.
 *
 * The conversation engine's own mic monitor only runs while a
 * conversation is active, so during the wizard we build a private
 * AnalyserNode straight off the peer connection. The level is throttled
 * to ~25 Hz so the React tree doesn't churn on every audio frame.
 */

import { useEffect, useState } from 'react';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';

export function useRobotMicLevel(session: RobotSessionHandle): { level: number; isActive: boolean } {
  const [level, setLevel] = useState(0);
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
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    void ctx.resume().catch(() => {});
    setIsActive(true);

    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 40) return;
      last = t;
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length) / 255;
      setLevel(Math.min(1, rms * 2.4));
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      setIsActive(false);
      try {
        source.disconnect();
      } catch {
        // ignore
      }
      void ctx.close().catch(() => {});
    };
  }, [session]);

  return { level, isActive };
}
