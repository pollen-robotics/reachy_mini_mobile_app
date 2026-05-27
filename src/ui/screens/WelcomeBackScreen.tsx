/**
 * Brief celebratory transition shown after a successful HF sign-in.
 *
 * Bridges two states the user otherwise experiences as a hard cut:
 *   - The browser-side OAuth flow returns the focus to the app.
 *   - The app suddenly switches from the sign-in screen to the
 *     scan screen.
 *
 * Without this, the user has no acknowledgment that the sign-in
 * succeeded - they just land on a list of robots without knowing
 * who they are. This screen surfaces their username for ~1.5 s
 * with a subtle entrance animation, then fades out into the scan
 * view (which is already mounted underneath and warming its data
 * cache via `useRemoteRobots`, so the user lands on a populated
 * list rather than a spinner).
 *
 * Implementation
 * ──────────────
 * The host renders this on top of `ScanScreen` as a fixed overlay
 * (`zIndex: 1300`, the MUI modal layer). The component owns its
 * own visibility timer and emits `onDone` after the fade-out
 * completes - the host then unmounts it.
 *
 * Pure presentational, no network calls; the data fetch happens
 * in the background on the screen behind us.
 */
import { useEffect, useState } from 'react';
import { Box, Fade, Stack, Typography, keyframes } from '@mui/material';

import hfLogoUrl from '@/assets/hf-logo.svg';
import { DURATION, FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

/**
 * How long the welcome sits at full opacity before starting to
 * fade out. Includes the staggered entrance window (~750 ms for
 * logo + headline + subtitle) plus a comfortable reading beat
 * (~2.7 s) so the user has time to read the username and see
 * the celebratory moment land before the scan view takes over.
 */
const VISIBLE_MS = 3400;

/**
 * Pop-in keyframes used to stagger the entrance of the logo and
 * the headline. Slight overshoot via `cubic-bezier(0.34, 1.56,
 * 0.64, 1)` gives the entrance an "earned" feel rather than a
 * dry fade.
 */
const popInKeyframes = keyframes`
  0% {
    transform: scale(0.7);
    opacity: 0;
  }
  60% {
    transform: scale(1.06);
    opacity: 1;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
`;

interface WelcomeBackScreenProps {
  username: string | null;
  onDone: () => void;
}

export default function WelcomeBackScreen({ username, onDone }: WelcomeBackScreenProps) {
  const [show, setShow] = useState(true);

  useEffect(() => {
    const t = window.setTimeout(() => setShow(false), VISIBLE_MS);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <Fade in={show} timeout={DURATION.base} onExited={onDone}>
      <Box
        sx={{
          position: 'fixed',
          inset: 0,
          zIndex: 1300,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.default',
          color: 'text.primary',
          // Block any tap from reaching the scan screen behind
          // while the welcome is still on screen.
          touchAction: 'none',
        }}
      >
        <Box
          component="img"
          src={hfLogoUrl}
          alt=""
          aria-hidden
          sx={{
            width: 72,
            height: 72,
            mb: 3,
            display: 'block',
            animation: `${popInKeyframes} 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) both`,
          }}
        />
        <Stack
          spacing={0.5}
          sx={{
            alignItems: 'center',
          }}
        >
          <Typography
            component="h1"
            sx={{
              fontSize: TYPO.hero,
              fontWeight: FONT_WEIGHT.bold,
              letterSpacing: '-0.3px',
              textAlign: 'center',
              m: 0,
              animation: `${popInKeyframes} 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) both 0.08s`,
            }}
          >
            {username ? `Hello, ${username}` : 'Welcome back'}
          </Typography>
          <Typography
            sx={{
              fontSize: TYPO.md,
              color: 'text.secondary',
              textAlign: 'center',
              animation: `${popInKeyframes} 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) both 0.16s`,
            }}
          >
            Looking up your Reachies…
          </Typography>
        </Stack>
      </Box>
    </Fade>
  );
}
