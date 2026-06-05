/**
 * PieTimer - a tiny "camembert" that fills clockwise from empty to full over a
 * fixed duration (default ~80s, the rough sticker-bake time). A faux progress
 * cue, not a real measurement: it just signals "something is cooking" with a
 * readable shape even at ~12px.
 *
 * Built as an SVG pie via the stroke-dasharray trick: a circle whose stroke is
 * as thick as its radius fills inward to the centre as the dash offset shrinks.
 * A thin track ring keeps the full circle's outline visible while it fills, so
 * the shape stays legible when empty and tiny.
 */
import { Box, alpha } from '@mui/material';

interface PieTimerProps {
  /** Diameter in px. */
  size?: number;
  /** Time to go from empty to full, in ms. */
  durationMs?: number;
  /**
   * Wall-clock ms (e.g. `Date.now()`) at which the tracked work started. When
   * provided, the fill is anchored to the REAL elapsed time via a negative
   * animation delay, so the pie shows the correct progress even if this
   * component (re)mounts mid-way - it isn't reset by a remount. When omitted
   * it simply starts filling from now.
   */
  startedAt?: number;
}

// Inner pie circle radius in the 32x32 viewBox; stroke width is 2x this so the
// wedge fills inward to the centre. Sized so the wedge's outer edge (2*R) meets
// the border ring's inner edge (15 - 2.5/2 = 13.75), leaving no gap between the
// filled pie and its surrounding border.
const R = 6.875;
const CIRCUMFERENCE = 2 * Math.PI * R;

export default function PieTimer({ size = 13, durationMs = 80000, startedAt }: PieTimerProps) {
  // Anchor the CSS animation to the real start time: a negative delay equal to
  // the elapsed time fast-forwards the fill to where it should already be. We
  // snapshot it once per mount (it only needs to be right at mount; the CSS
  // animation carries it forward from there).
  const elapsedMs = startedAt != null ? Math.max(0, Date.now() - startedAt) : 0;
  return (
    <Box
      component="svg"
      viewBox="0 0 32 32"
      aria-hidden
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'block',
        // Start the fill at 12 o'clock and sweep clockwise.
        transform: 'rotate(-90deg)',
      }}
    >
      {/* Track ring: keeps the circle's outline visible while the pie fills. */}
      <Box
        component="circle"
        cx={16}
        cy={16}
        r={15}
        sx={{
          fill: 'none',
          stroke: t => alpha(t.palette.text.primary, 0.18),
          strokeWidth: 2.5,
        }}
      />
      {/* Filling wedge. */}
      <Box
        component="circle"
        cx={16}
        cy={16}
        r={R}
        sx={{
          fill: 'none',
          stroke: t => alpha(t.palette.text.primary, 0.18),
          strokeWidth: 2 * R,
          strokeDasharray: CIRCUMFERENCE,
          '@keyframes pieTimerFill': {
            from: { strokeDashoffset: CIRCUMFERENCE },
            to: { strokeDashoffset: 0 },
          },
          animation: `pieTimerFill ${durationMs}ms linear forwards`,
          // Negative delay = "already elapsed", so a remount resumes at the
          // right fill instead of restarting from empty.
          animationDelay: `-${elapsedMs}ms`,
          '@media (prefers-reduced-motion: reduce)': {
            animation: 'none',
            strokeDashoffset:
              CIRCUMFERENCE * (1 - Math.min(1, elapsedMs / durationMs)),
          },
        }}
      />
    </Box>
  );
}
