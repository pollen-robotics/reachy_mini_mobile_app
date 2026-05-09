/**
 * Brand splash shown once on app boot, before the auth gate.
 *
 * Two layers of "splash" in this app:
 *   - **Native launch screen** (iOS `LaunchScreen.storyboard`,
 *     Android launcher theme) - shown by the OS between the icon
 *     tap and the WebView being ready. We do not control its
 *     timing; on cold start it can be ~300-700 ms.
 *   - **This React splash** - takes over at first paint of the
 *     WebView. It overlaps the auth-token probe + BLE listener
 *     init, then fades out. A short minimum visible time
 *     (`SPLASH_VISIBLE_MS`) prevents a perceptible flash when
 *     the WebView is already warm.
 *
 * The splash itself is intentionally featherweight: a centred
 * hero illustration, the product name, and a fade transition.
 * No network, no permissions prompt, no async waiting - the
 * parent (`App.tsx`) is the one that gates the rest of the
 * boot sequence on `onDone`.
 */
import { useEffect, useState } from 'react';
import { Box, Fade, Typography } from '@mui/material';

import HeroIllustration from '@/ui/design/HeroIllustration';
import reachyBusteSvg from '../assets/reachy-buste.svg';
import { DURATION, FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';

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
          src={reachyBusteSvg}
          alt="Reachy Mini"
          animation="none"
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
