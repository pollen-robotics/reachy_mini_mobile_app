/**
 * Brand splash shown once on app boot, before the auth gate.
 *
 * Two layers of "splash" in this app:
 *   - **Native launch screen** (iOS `LaunchScreen.storyboard`,
 *     Android launcher theme) - shown by the OS between the icon
 *     tap and the WebView being ready. We do not control its
 *     timing; on cold start it can be ~300-700 ms.
 *   - **This React splash** - takes over at first paint of the
 *     WebView. It overlaps the auth-token probe, then fades out.
 *     A short minimum visible time (`SPLASH_VISIBLE_MS`) prevents
 *     a perceptible flash when the WebView is already warm.
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
import reachyBusteSvg from '@/assets/reachy-buste.svg';
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
          // `100dvh` follows the dynamic viewport (iOS keyboard, iOS
          // call-in-progress dynamic-island expansion) so the splash
          // never leaks a band of system bg. `100vh` fallback ahead
          // of `100dvh` keeps WebKits older than iOS 15.4 working.
          height: ['100vh', '100dvh'],
          bgcolor: 'background.default',
          color: 'text.primary',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          // Relative so the absolutely-positioned version stamp below
          // anchors to the screen edges (and respects the iOS home
          // indicator safe-area inset on iPhone X+).
          position: 'relative',
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

        {/* Build version stamp. Anchored to the bottom of the splash
            with a discreet `text.secondary` colour + small fixed
            opacity so it never competes with the hero illustration.
            Sourced from the npm `package.json` via the `__APP_VERSION__`
            define in `vite.config.ts`, so a `yarn version` bump is
            the only place we ever touch the value. */}
        <Typography
          aria-label={`App version ${__APP_VERSION__}`}
          sx={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: `calc(${LAYOUT.safeAreaBottom} + 16px)`,
            textAlign: 'center',
            fontSize: TYPO.tiny,
            fontWeight: FONT_WEIGHT.regular,
            color: 'text.secondary',
            opacity: 0.6,
            letterSpacing: '0.2px',
          }}
        >
          v{__APP_VERSION__}
        </Typography>
      </Box>
    </Fade>
  );
}
