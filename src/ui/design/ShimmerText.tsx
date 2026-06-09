/**
 * ShimmerText - a "working" text cue with a single highlight band that sweeps
 * across grey text, à la Cursor's agent-thinking shimmer.
 *
 * Phase-locked to the avatar disc's `CookingMonogram` skeleton: identical
 * period + a wall-clock-anchored delay so every cue on screen beats on the
 * same grid. The delay carries an extra half-period offset so the text wave
 * and the disc wave ALTERNATE (peak on opposite half-cycles) rather than
 * flashing together.
 *
 * Mechanics that matter:
 *  - ONE band only (`no-repeat`), 360% wide, so it sits fully OFF the text at
 *    both ends of the cycle -> the loop reset happens off-screen with no snap.
 *  - The text window stays fully covered by the base colour for every
 *    position, so no glyph ever drops out (background-clip: text would render
 *    uncovered glyphs transparent).
 *  - The band crosses the text exactly once per period, peaking dead-centre at
 *    mid-cycle.
 *
 * Caller controls typography (font size/weight/line-height) via `sx`; this
 * component owns only the colour + sweep.
 */
import { useMemo, type ReactNode } from 'react';
import { Box } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';

import { SHIMMER_PERIOD_MS } from './CookingMonogram';

interface ShimmerTextProps {
  children: ReactNode;
  /** Extra styles (typically font size/weight) merged after the shimmer base. */
  sx?: SxProps<Theme>;
}

export default function ShimmerText({ children, sx }: ShimmerTextProps) {
  // Anchor to the wall clock (so independently-mounted cues stay in phase) and
  // add a half-period offset to counter-phase against the disc shimmer.
  const delay = useMemo(
    () => -(Date.now() % SHIMMER_PERIOD_MS) - SHIMMER_PERIOD_MS / 2,
    [],
  );
  return (
    <Box
      component="span"
      sx={[
        t => {
          const base = t.palette.text.disabled;
          const hi = `color-mix(in srgb, ${t.palette.text.primary} 62%, ${t.palette.primary.main})`;
          return {
            display: 'inline-block',
            backgroundImage: `linear-gradient(100deg, ${base} 0%, ${base} 33%, ${hi} 50%, ${base} 67%, ${base} 100%)`,
            backgroundSize: '360% 100%',
            backgroundRepeat: 'no-repeat',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
            '@keyframes shimmerTextSweep': {
              '0%': { backgroundPosition: '100% 0' },
              '100%': { backgroundPosition: '0% 0' },
            },
            animation: `shimmerTextSweep ${SHIMMER_PERIOD_MS}ms ease-in-out infinite`,
            animationDelay: `${delay}ms`,
            '@media (prefers-reduced-motion: reduce)': {
              color: base,
              animation: 'none',
            },
          };
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {children}
    </Box>
  );
}
