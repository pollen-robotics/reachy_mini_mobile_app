/**
 * Centred SVG hero illustration with an optional gentle float animation.
 *
 * Used at the top of every "single-purpose" screen (scan, transition, wifi
 * setup phases) to give each state its own identity, mirroring the desktop
 * app's use of `astronaut`, `reachy-detective`, `rocket`, etc.
 */

import { Box, keyframes } from '@mui/material';
import { LAYOUT } from '../styles/tokens';

const floatKf = keyframes`
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
`;

const pulseKf = keyframes`
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.03); opacity: 0.92; }
`;

export type HeroAnimation = 'none' | 'float' | 'pulse';

interface HeroIllustrationProps {
  src: string;
  alt: string;
  size?: number;
  animation?: HeroAnimation;
  mb?: number;
}

export default function HeroIllustration({
  src,
  alt,
  size = LAYOUT.heroSize,
  animation = 'float',
  mb = 3,
}: HeroIllustrationProps) {
  const anim =
    animation === 'float'
      ? `${floatKf} 4s ease-in-out infinite`
      : animation === 'pulse'
        ? `${pulseKf} 2s ease-in-out infinite`
        : 'none';

  return (
    <Box
      sx={{
        width: size,
        height: size,
        mb,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: anim,
        flexShrink: 0,
      }}
    >
      <img
        src={src}
        alt={alt}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      />
    </Box>
  );
}
