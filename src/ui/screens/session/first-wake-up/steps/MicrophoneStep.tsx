import { useEffect, useRef, useState } from 'react';
import { Box, LinearProgress, Stack, Typography, alpha, keyframes } from '@mui/material';
import { AnimatePresence, motion } from 'motion/react';

import pointingHandUrl from '@/assets/pointing-hand.svg';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { FONT_WEIGHT, STATUS, TYPO } from '@/ui/design/tokens';
import { TROUBLE_TIPS } from '../constants';
import { useTroubleshoot } from '../hooks';
import { StepScaffold, TroubleLink, TroubleshootView } from '../shared';
import { useRobotMicLevel } from '../useRobotMicLevel';
import FrequencyBars from '../FrequencyBars';

// One constant cadence for the whole gesture. Tying the duration to the live
// mic `detected` flag (as before) restarted the CSS animation every time the
// flag toggled near the threshold -> visible flicker. A single fixed duration
// keeps the hand steady.
const TAP_MS = 1400;

/** Hand tapping straight down onto the head then lifting back up. translateY
 *  only (X centering lives on the wrapper); start == end for a seamless loop.
 *  A pure, continuous up/down oscillation with NO flat holds - `ease-in-out`
 *  gives smooth turnarounds so it never stops, it just reverses. The bottom
 *  (50%) is where the hand meets the head. */
const tap = keyframes`
  0%   { transform: translateY(-14px); }
  50%  { transform: translateY(0px); }
  100% { transform: translateY(-14px); }
`;

/** Live smoothed level above which we count the mic as "hearing" you. Set so a
 *  deliberate scratch/voice registers but ambient room noise doesn't trip it -
 *  the check is a "does the mic work" confidence beat, not a hair-trigger. */
const DETECTION_THRESHOLD = 0.32;
/** Seconds of sustained sound required to pass the mic check. */
const DETECTION_DURATION_REQUIRED = 2;
/** A quiet gap tolerated before the progress resets. Generous so a natural
 *  pause between scratches doesn't wipe the user's progress. */
const DETECTION_GRACE_PERIOD = 1.5;

export default function MicrophoneStep({
  session,
  onNext,
  onStageVisible,
}: {
  session: RobotSessionHandle;
  onNext: () => void;
  onStageVisible: (visible: boolean) => void;
}) {
  const { trouble, openTrouble, closeTrouble } = useTroubleshoot(onStageVisible);
  const { level, isActive } = useRobotMicLevel(session);
  const [progress, setProgress] = useState(0);
  const [complete, setComplete] = useState(false);

  const accumulatedRef = useRef(0);
  const lastTickRef = useRef<number | null>(null);
  const doneRef = useRef(false);

  const detected = isActive && level > DETECTION_THRESHOLD;

  // Accumulate sustained sound. Rubbing Reachy's head (or talking near
  // it) feeds its mic; a few seconds of that fills the bar and advances.
  useEffect(() => {
    if (complete) return;
    const now = Date.now() / 1000;
    if (detected) {
      if (lastTickRef.current != null) accumulatedRef.current += now - lastTickRef.current;
      lastTickRef.current = now;
      setProgress(Math.min(accumulatedRef.current / DETECTION_DURATION_REQUIRED, 1));
      if (accumulatedRef.current >= DETECTION_DURATION_REQUIRED && !doneRef.current) {
        doneRef.current = true;
        setComplete(true);
        setProgress(1);
        window.setTimeout(onNext, 900);
      }
    } else if (lastTickRef.current != null) {
      const gap = now - lastTickRef.current;
      if (gap > DETECTION_GRACE_PERIOD) {
        accumulatedRef.current = 0;
        lastTickRef.current = null;
        setProgress(0);
      }
    }
  }, [level, detected, complete, onNext]);

  // Calm, low-churn copy: keyed off progress (not the instantaneous `detected`
  // flag, which flickers around the threshold) so each phrase change is a
  // meaningful beat the hint animation can play cleanly. The live FrequencyBars
  // already give the moment-to-moment "I hear you" feedback.
  const status = !isActive
    ? 'Connecting to the microphone…'
    : complete
      ? 'I heard you! Moving on…'
      : progress > 0
        ? "Great - keep going, don't stop…"
        : 'Listening… rub my head or make some noise';

  if (trouble) {
    return (
      <TroubleshootView
        title={TROUBLE_TIPS.microphone.title}
        tips={TROUBLE_TIPS.microphone.tips}
        onBack={closeTrouble}
      />
    );
  }

  return (
    <StepScaffold
      title="Wake Me Up"
      caption="Gently scratch the top of my head to wake me up. I'll respond when I'm ready."
      stageOverlay={
        // The head is the shared persistent viz behind this slot; overlay a
        // white hand tapping the top of it to point the user at where to rub.
        // Positions are a fraction of the stage height so they track the
        // robot's head.
        // Wrapper owns the X centering; inner box does the translateY tap so
        // the keyframe never has to repeat the -50% and can't drift.
        <Box aria-hidden sx={{ position: 'absolute', top: '25%', left: '50%', transform: 'translateX(-50%)' }}>
          <Box sx={{ animation: `${tap} ${TAP_MS}ms ease-in-out infinite` }}>
            {/* Self-contained hand asset (white fill + outline baked in), just
                rotated to point down onto the head. */}
            <Box
              component="img"
              src={pointingHandUrl}
              alt=""
              sx={{ display: 'block', height: 54, width: 'auto', transform: 'rotate(180deg)' }}
            />
          </Box>
        </Box>
      }
      feedback={
        <Stack spacing={1.5} sx={{ width: '100%', maxWidth: 320, alignItems: 'center' }}>
          <Box sx={{ width: '100%' }}>
            <FrequencyBars level={level} isActive={isActive} height={56} />
          </Box>
          <Box sx={{ width: '100%' }}>
            <LinearProgress
              variant="determinate"
              value={progress * 100}
              sx={{
                height: 6,
                borderRadius: 3,
                bgcolor: theme => alpha(theme.palette.text.primary, 0.08),
                '& .MuiLinearProgress-bar': {
                  borderRadius: 3,
                  bgcolor: complete ? STATUS.success : 'primary.main',
                },
              }}
            />
          </Box>
          {/* Tutorial-style hint: each new phrase fades + rises in as the old
              one fades + rises out. `mode="wait"` sequences them so they never
              overlap; the reserved height keeps the layout from jumping. */}
          <Box sx={{ position: 'relative', width: '100%', minHeight: 40, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={status}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
                style={{ position: 'absolute', width: '100%' }}
              >
                <Typography
                  sx={{
                    fontSize: TYPO.sm,
                    color: complete ? STATUS.success : 'text.secondary',
                    fontWeight: complete ? FONT_WEIGHT.semibold : FONT_WEIGHT.regular,
                    textAlign: 'center',
                  }}
                >
                  {status}
                </Typography>
              </motion.div>
            </AnimatePresence>
          </Box>
        </Stack>
      }
      actions={
        !complete ? <TroubleLink label="Sound doesn't work" onClick={openTrouble} /> : null
      }
    />
  );
}
