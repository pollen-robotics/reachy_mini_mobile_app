/**
 * Brand splash shown once on app boot, before the auth gate.
 *
 * iOS already paints `LaunchScreen.storyboard` between the icon tap and
 * the WebView being ready, so this React splash starts at first paint
 * and overlaps the auth-token probe and BLE listener init. A short
 * minimum visible time avoids a perceptible flash on warm starts; the
 * fade-out signals the parent it can mount the real UI.
 */

import { useEffect, useState } from 'react';
import { Box, Fade, Typography } from '@mui/material';

import HeroIllustration from '../components/HeroIllustration';
import reachyStandardSvg from '../assets/reachy-standard.svg';
import { DURATION, FONT_WEIGHT, LAYOUT, TYPO } from '../styles/tokens';

const SPLASH_VISIBLE_MS = 1200;

interface SplashScreenProps {
  onDone: () => void;
}

export default function SplashScreen({ onDone }: SplashScreenProps) {
  const [show, setShow] = useState(true);

  useEffect(() => {
    const t = window.setTimeout(() => setShow(false), SPLASH_VISIBLE_MS);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <Fade in={show} timeout={DURATION.base} onExited={onDone}>
      <Box
        sx={{
          width: '100vw',
          height: '100vh',
          bgcolor: 'background.default',
          color: 'text.primary',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <HeroIllustration
          src={reachyStandardSvg}
          alt="Reachy Mini"
          animation="float"
          size={LAYOUT.heroSize}
          mb={2}
        />
        <Typography
          sx={{
            fontSize: TYPO.display,
            fontWeight: FONT_WEIGHT.semibold,
            letterSpacing: '-0.3px',
          }}
        >
          Reachy Mini
        </Typography>
      </Box>
    </Fade>
  );
}
