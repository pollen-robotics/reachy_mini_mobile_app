/**
 * CookingRing - a determinate "filling donut" progress ring for the
 * ~1-minute sticker-avatar bake, mirroring the Reachy sticker
 * generator's loader.
 *
 * The sticker API doesn't stream real progress, so this is a time-based
 * estimate: it eases from 0 toward 95% over `estimatedSeconds`, then
 * holds at 95% until the parent stops rendering it (i.e. the avatar
 * landed).
 *
 * The fill is anchored to `startedAt` (the moment the generation actually
 * began, tracked per-persona in the store) so progress is INDEPENDENT of
 * when this component mounts - it stays correct across remounts
 * (navigating away from the picker and back, the band re-rendering, …).
 * When `startedAt` is omitted it falls back to mount time.
 *
 * Renders a faint full-circle track with the primary-coloured progress
 * arc on top (rounded cap), absolutely centred over its positioned
 * parent so it sits concentric with the avatar disc.
 */
import { useEffect, useRef, useState } from 'react';
import { Box, CircularProgress } from '@mui/material';

interface CookingRingProps {
  /** Outer diameter in px (match the avatar disc it rings). */
  size: number;
  /** Stroke thickness (MUI CircularProgress units). */
  thickness?: number;
  /** Estimated bake time the donut fills over. Defaults to 80s. */
  estimatedSeconds?: number;
  /** Epoch ms when the generation began. Anchors the fill so it survives
   *  remounts. Falls back to mount time when omitted/null. */
  startedAt?: number | null;
}

export default function CookingRing({
  size,
  thickness = 1,
  estimatedSeconds = 80,
  startedAt = null,
}: CookingRingProps) {
  const mountRef = useRef(Date.now());
  // Seed `elapsed` with the REAL elapsed time on the very first render
  // (lazy init), not 0. Otherwise a remount (e.g. swiping away from the
  // ring's view and back) paints at 0% first, then the effect snaps it to
  // the true value - and the `stroke-dashoffset` transition animates that
  // jump, so you'd see the arc sweep from zero up to the current progress.
  // Seeding it correctly means the arc appears already at its progress.
  const [elapsed, setElapsed] = useState(
    () => (Date.now() - (startedAt ?? mountRef.current)) / 1000,
  );

  useEffect(() => {
    const base = startedAt ?? mountRef.current;
    const tick = () => setElapsed((Date.now() - base) / 1000);
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [startedAt]);

  // Ease toward (but never reach) 95% so a slow bake doesn't look stuck
  // "full" before the avatar actually lands.
  const progress = Math.min((elapsed / estimatedSeconds) * 100, 95);

  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: size,
        height: size,
        pointerEvents: 'none',
      }}
    >
      <CircularProgress
        variant="determinate"
        value={100}
        size={size}
        thickness={thickness}
        sx={{
          position: 'absolute',
          inset: 0,
          color: theme =>
            theme.palette.mode === 'dark'
              ? 'rgba(255, 255, 255, 0.10)'
              : 'rgba(0, 0, 0, 0.07)',
        }}
      />
      <CircularProgress
        variant="determinate"
        value={progress}
        size={size}
        thickness={thickness}
        sx={{
          position: 'absolute',
          inset: 0,
          // Quieter arc: the bake is a background nicety, not the
          // headline, so the progress ring whispers (faded primary +
          // thin stroke) rather than drawing a bold orange sweep.
          color: 'primary.main',
          opacity: 0.55,
          '& .MuiCircularProgress-circle': {
            strokeLinecap: 'round',
            transition: 'stroke-dashoffset 0.3s linear',
          },
        }}
      />
    </Box>
  );
}
