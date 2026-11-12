/**
 * Full-screen robot camera for the telepresence tab.
 *
 * Two layers, same cover-fit:
 *  - `<video>`: the browser's own WebRTC path. Always attached, so it's
 *    the instant fallback (and what shows while the low-latency path
 *    waits for its first keyframe).
 *  - `<canvas>`: the WebCodecs low-latency path (`low-latency-video.ts`),
 *    which skips the browser jitter buffer. Once it paints its first
 *    frame the `<video>` is hidden (it keeps decoding, cheap to show back).
 *
 * Forced muted: robot audio plays through the telepresence audio element,
 * and the SDK would otherwise mirror its own mute flag onto the element.
 */
import { useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';

import { lowLatencyVideo } from '@/features/robot-session/low-latency-video';

export type LiveVideoMode = 'standard' | 'low-latency' | 'starting' | 'unsupported';

interface LiveVideoProps {
  attachVideo: (el: HTMLVideoElement) => () => void;
  live: boolean;
  lowLatency: boolean;
  onModeChange?: (mode: LiveVideoMode) => void;
}

const ARM_RETRY_MS = 1000;
const ARM_RETRIES = 5;

const layerSx = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
} as const;

export default function LiveVideo({ attachVideo, live, lowLatency, onModeChange }: LiveVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<LiveVideoMode>('standard');

  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;
  useEffect(() => onModeChangeRef.current?.(mode), [mode]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !live) return;
    const detach = attachVideo(el);
    el.muted = true;
    const keepMuted = () => {
      if (!el.muted) el.muted = true;
    };
    el.addEventListener('volumechange', keepMuted);
    return () => {
      el.removeEventListener('volumechange', keepMuted);
      detach();
    };
  }, [live, attachVideo]);

  useEffect(() => {
    if (!live || !lowLatency) {
      setMode('standard');
      return;
    }
    let cancelled = false;
    let detach: (() => void) | null = null;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A canvas can only be handed to the worker once
    // (`transferControlToOffscreen`), so each activation gets a fresh one.
    const host = canvasHostRef.current;
    if (!host) return;
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { width: '100%', height: '100%', objectFit: 'cover', display: 'block' });
    host.appendChild(canvas);
    const tryAttach = () => {
      if (cancelled) return;
      const result = lowLatencyVideo.attachCanvas(canvas, {
        onFirstFrame: () => {
          if (!cancelled) setMode('low-latency');
        },
      });
      if (typeof result === 'function') {
        detach = result;
        setMode('starting');
      } else if (result === 'not-armed' && retries++ < ARM_RETRIES) {
        // Session's video track may not have landed yet.
        timer = setTimeout(tryAttach, ARM_RETRY_MS);
      } else {
        setMode(result === 'unsupported' ? 'unsupported' : 'standard');
      }
    };
    tryAttach();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      detach?.();
      canvas.remove();
    };
  }, [live, lowLatency]);

  return (
    <>
      <Box
        component="video"
        ref={videoRef}
        autoPlay
        playsInline
        muted
        sx={{ ...layerSx, visibility: mode === 'low-latency' ? 'hidden' : 'visible' }}
      />
      <Box
        ref={canvasHostRef}
        sx={{ ...layerSx, visibility: mode === 'low-latency' ? 'visible' : 'hidden' }}
      />
    </>
  );
}
