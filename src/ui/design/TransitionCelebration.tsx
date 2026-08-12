/**
 * Brief celebratory transition overlay.
 *
 * A generic, reusable version of `WelcomeBackScreen`'s post-OAuth moment:
 * a full-screen fade with a staggered pop-in (icon + headline + subtitle)
 * that sits for a short beat, then fades out and calls `onDone`. Used to
 * bridge a form submission and the next view (e.g. the setup naming step
 * before account linking, or the end of the first wake-up before the
 * conversation) so the handoff feels earned instead of a hard cut.
 *
 * Pure presentational: it owns only its visibility timer. The caller
 * mounts it on top of the current screen and advances on `onDone`.
 */
import { useEffect, useState } from 'react';
import { Box, Fade, Stack, Typography, keyframes } from '@mui/material';

import { DURATION, FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

/**
 * Pop-in with a slight overshoot so the entrance reads as celebratory
 * rather than a dry fade. Mirrors `WelcomeBackScreen`.
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

interface TransitionCelebrationProps {
  /** Main line (e.g. "Nice to meet you, Nova"). */
  title: string;
  /** Optional supporting line under the title. */
  subtitle?: string;
  /** Optional visual anchor above the title (e.g. a robot avatar). */
  icon?: React.ReactNode;
  /** How long to sit at full opacity before fading out (ms). */
  visibleMs?: number;
  /** Fired after the fade-out completes - the caller then advances. */
  onDone: () => void;
}

export default function TransitionCelebration({
  title,
  subtitle,
  icon,
  visibleMs = 1500,
  onDone,
}: TransitionCelebrationProps) {
  const [show, setShow] = useState(true);

  useEffect(() => {
    const t = window.setTimeout(() => setShow(false), visibleMs);
    return () => window.clearTimeout(t);
  }, [visibleMs]);

  return (
    <Fade in={show} timeout={DURATION.base} onExited={onDone}>
      <Box
        sx={{
          position: 'fixed',
          inset: 0,
          // Above both wizards (setup screen + first-wake-up at 1380) so the
          // celebration always covers the form it transitions away from.
          zIndex: 1600,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.default',
          color: 'text.primary',
          px: 3,
          // Swallow taps while the celebration is on screen.
          touchAction: 'none',
        }}
      >
        {icon ? (
          <Box
            sx={{
              mb: 3,
              display: 'flex',
              animation: `${popInKeyframes} 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) both`,
            }}
          >
            {icon}
          </Box>
        ) : null}
        <Stack spacing={0.5} sx={{ alignItems: 'center' }}>
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
            {title}
          </Typography>
          {subtitle ? (
            <Typography
              sx={{
                fontSize: TYPO.md,
                color: 'text.secondary',
                textAlign: 'center',
                animation: `${popInKeyframes} 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) both 0.16s`,
              }}
            >
              {subtitle}
            </Typography>
          ) : null}
        </Stack>
      </Box>
    </Fade>
  );
}
