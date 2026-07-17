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

// Detection runs on the hook's `activity` signal (onset strength), NOT raw
// amplitude. Steady ambient noise reads ~0 there, so none of this trips on a
// quiet-but-humming room. Hysteresis (two thresholds) stops the gate from
// chattering when activity hovers near the edge.
/** Cross this to count as "input happening" (gate opens). */
const ACTIVITY_ON = 0.28;
/** Drop below this before the gate closes again (must be < ACTIVITY_ON). */
const ACTIVITY_OFF = 0.14;
/** Credits needed to pass. Roughly: a handful of taps, or ~1.5 s of scratch. */
const DETECTION_REQUIRED = 1.6;
/** Each fresh onset (rising edge) is worth this much credit - this is what
 *  makes short taps count for something instead of barely nudging the bar. */
const TAP_CREDIT = 0.32;
/** Credit per second of sustained activity at full strength (covers scratching). */
const SUSTAIN_GAIN = 1;
/** A quiet gap tolerated before progress resets. Generous so a natural pause
 *  between taps doesn't wipe the user's progress. */
const DETECTION_GRACE_PERIOD = 1.5;
/** Clamp on per-frame dt so a stalled tab can't dump a huge chunk of credit. */
const MAX_DT = 0.2;

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
  const { level, activity, isActive } = useRobotMicLevel(session);
  const [progress, setProgress] = useState(0);
  const [complete, setComplete] = useState(false);

  const accumulatedRef = useRef(0);
  const lastTickRef = useRef<number | null>(null);
  const lastLoudRef = useRef<number | null>(null);
  const gateOpenRef = useRef(false);
  const doneRef = useRef(false);

  // Turn the onset `activity` into progress. Two ways to earn credit:
  //   1. a discrete tap  -> a chunk (TAP_CREDIT) on each rising edge
  //   2. sustained scratch -> dt * activity while the gate stays open
  // Ambient noise -> activity ~0 -> gate never opens -> zero accumulation, so
  // neither the bar nor the progress climbs "for nothing".
  useEffect(() => {
    if (complete) return;
    const now = Date.now() / 1000;
    const dt = lastTickRef.current == null ? 0 : Math.min(now - lastTickRef.current, MAX_DT);
    lastTickRef.current = now;

    // Hysteresis: once open, tolerate a lower level before closing.
    const open = gateOpenRef.current ? activity > ACTIVITY_OFF : activity > ACTIVITY_ON;

    if (open) {
      if (!gateOpenRef.current) accumulatedRef.current += TAP_CREDIT; // rising edge = a tap
      accumulatedRef.current += dt * activity * SUSTAIN_GAIN; // scratch
      gateOpenRef.current = true;
      lastLoudRef.current = now;
    } else {
      gateOpenRef.current = false;
      if (lastLoudRef.current != null && now - lastLoudRef.current > DETECTION_GRACE_PERIOD) {
        accumulatedRef.current = 0;
        lastLoudRef.current = null;
      }
    }

    const next = Math.min(accumulatedRef.current / DETECTION_REQUIRED, 1);
    setProgress(next);
    if (accumulatedRef.current >= DETECTION_REQUIRED && !doneRef.current) {
      doneRef.current = true;
      setComplete(true);
      setProgress(1);
      window.setTimeout(onNext, 900);
    }
  }, [activity, complete, onNext]);

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
            <FrequencyBars level={Math.max(level, activity)} isActive={isActive} height={56} />
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
          <Box
            aria-live="polite"
            sx={{ position: 'relative', width: '100%', minHeight: 40, display: 'flex', justifyContent: 'center', alignItems: 'center' }}
          >
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
