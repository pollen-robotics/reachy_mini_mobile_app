/**
 * Reusable Reachy avatar.
 *
 * Tinted disc with the `reachy-standard` SVG sitting inside it - the
 * antennas overflow above the rim so the silhouette feels alive
 * rather than cropped. Used in two places today:
 *
 *   - Discovery cards on `ScanScreen` (size 72)
 *   - Connected-session top bar identity block (size ~36)
 *
 * Centering math
 * ──────────────
 * The reachy-standard SVG (720 × 721) is not visually balanced:
 *   - antennas live in the upper ~17% (SVG y ≈ 125-165)
 *   - the head body fills 17-83% (SVG y ≈ 165-597)
 *   - the lower ~17% is empty whitespace
 *
 * To put the *head body* (not the SVG's geometric centre) at the
 * centre of the disc we render the SVG at 155% of the disc width
 * and shift it up by 60% of its own height. The antennas naturally
 * peek a few pixels above the rim, the head fills the disc, and
 * the empty bottom of the SVG is invisible (transparent
 * background).
 */
import { Box } from '@mui/material';

import reachyStandardSvg from '../assets/reachy-standard.svg';

interface RobotAvatarProps {
  /** Disc diameter in pixels. The SVG scales with the disc, so the
   *  visual proportions stay constant regardless of size. */
  size?: number;
  /** Optional override for the inner SVG scale, in the [0..2] range.
   *  Defaults to 1.55 (155%). Pull it lower (e.g. 1.3) when the
   *  parent can't tolerate the antennas peeking above the rim. */
  svgScale?: number;
}

export default function RobotAvatar({
  size = 72,
  svgScale = 1.55,
}: RobotAvatarProps) {
  return (
    <Box
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        position: 'relative',
        borderRadius: '50%',
        bgcolor: theme =>
          theme.palette.mode === 'dark'
            ? 'rgba(255,255,255,0.04)'
            : 'rgba(0,0,0,0.03)',
        border: theme =>
          `1px solid ${
            theme.palette.mode === 'dark'
              ? 'rgba(255,255,255,0.06)'
              : 'rgba(0,0,0,0.04)'
          }`,
        // We deliberately keep `overflow: visible` so the antennas
        // can break the disc silhouette. Parents that want a hard
        // crop should wrap us in their own clipping container.
        overflow: 'visible',
      }}
    >
      <Box
        component="img"
        src={reachyStandardSvg}
        alt=""
        aria-hidden
        sx={{
          position: 'absolute',
          width: `${svgScale * 100}%`,
          height: 'auto',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -60%)',
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      />
    </Box>
  );
}
