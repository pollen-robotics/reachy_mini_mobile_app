/**
 * Persona avatar disc.
 *
 * Circular tinted "stage" with the persona illustration rendered
 * oversized inside it so the head body lands dead centre and the
 * antennas / hats / accessories spill above the rim (`overflow:
 * visible`). This is the "RobotAvatar pattern" applied to arbitrary
 * persona artwork rather than the fixed `reachy-standard` SVG, and was
 * previously copy-pasted into `PersonalityPill` and `PersonalityStore`
 * with the same disc tint but drifting image scales.
 *
 * The translate(-50%, -57%) shift puts the head (not the artwork's
 * geometric centre) at the disc's centre, since the bottom ~17% of the
 * source illustrations is empty whitespace.
 *
 * When `src` is omitted the disc renders `children` instead (e.g. a
 * neutral "?" placeholder while authoring a brand-new persona).
 */
import { Box } from '@mui/material';
import type { ReactNode } from 'react';

interface PersonaAvatarProps {
  /** Persona artwork URL. When omitted, `children` is rendered instead. */
  src?: string;
  /** Disc diameter in pixels. */
  size: number;
  /**
   * Inner illustration scale as a fraction of the disc width. Defaults
   * to 1.4 (140%); the larger Store tile bumps it to 1.52 so the face
   * keeps the same optical weight at a bigger footprint.
   */
  imageScale?: number;
  /** Optional inset ring (used by the compact pill band). */
  boxShadow?: string;
  /** Placeholder rendered when `src` is absent. */
  children?: ReactNode;
}

export default function PersonaAvatar({
  src,
  size,
  imageScale = 1.4,
  boxShadow,
  children,
}: PersonaAvatarProps) {
  return (
    <Box
      sx={theme => ({
        width: size,
        height: size,
        flexShrink: 0,
        position: 'relative',
        borderRadius: '50%',
        bgcolor:
          theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)',
        ...(boxShadow ? { boxShadow } : null),
        overflow: 'visible',
        display: 'grid',
        placeItems: 'center',
      })}
    >
      {src ? (
        <Box
          component="img"
          src={src}
          alt=""
          aria-hidden
          draggable={false}
          sx={{
            position: 'absolute',
            width: `${imageScale * 100}%`,
            height: 'auto',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -57%)',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        />
      ) : (
        children
      )}
    </Box>
  );
}
