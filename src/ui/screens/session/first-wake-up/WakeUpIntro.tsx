/**
 * Intro / loading gate for the first wake-up wizard.
 *
 * Covers the wizard while the persistent 3D viz loads, framing the wait in the
 * wizard's own voice: the robot is "still asleep" and we're about to wake it up
 * together. Purely presentational and self-contained - the shell keeps it on
 * screen until the viz is ready (see `stepReady` in `index.tsx`), then
 * cross-fades to the first step.
 */
import { motion } from 'motion/react';
import { Stack, Typography } from '@mui/material';

import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

// Scale pop-in with a slight overshoot, staggered line by line - the same
// "earned entrance" as the post-OAuth welcome screen (WelcomeBackScreen), so
// the intro copy visibly animates in (a plain fade is too subtle to notice).
// The `1.56` control-point overshoots past scale 1 before settling.
const POP_IN_EASE: [number, number, number, number] = [0.34, 1.56, 0.64, 1];
const POP_IN_DURATION = 0.6;

export default function WakeUpIntro() {
  return (
    <Stack sx={{ alignItems: 'center', px: 4, textAlign: 'center' }}>
      <motion.div
        initial={{ opacity: 0, scale: 0.7 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: POP_IN_DURATION, ease: POP_IN_EASE, delay: 0.12 }}
      >
        <Typography
          component="h1"
          sx={{ fontSize: TYPO.hero, fontWeight: FONT_WEIGHT.bold, letterSpacing: '-0.3px', m: 0 }}
        >
          I&apos;m not quite awake yet
        </Typography>
      </motion.div>
      <motion.div
        initial={{ opacity: 0, scale: 0.7 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: POP_IN_DURATION, ease: POP_IN_EASE, delay: 0.24 }}
      >
        <Typography sx={{ mt: 1, fontSize: TYPO.md, color: 'text.secondary', lineHeight: 1.5, maxWidth: 280 }}>
          Give me a second - then let&apos;s wake me up together.
        </Typography>
      </motion.div>
    </Stack>
  );
}
