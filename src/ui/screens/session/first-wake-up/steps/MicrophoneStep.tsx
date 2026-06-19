import { useEffect, useRef, useState } from 'react';
import { Box, LinearProgress, Stack, Typography, alpha } from '@mui/material';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { FONT_WEIGHT, STATUS, TYPO } from '@/ui/design/tokens';
import { TROUBLE_TIPS } from '../constants';
import { Headline, TroubleLink, TroubleshootView } from '../shared';
import { useRobotMicLevel } from '../useRobotMicLevel';
import FrequencyBars from '../FrequencyBars';

/** Live smoothed level above which we count the mic as "hearing" you. */
const DETECTION_THRESHOLD = 0.28;
/** Seconds of sustained sound required to pass the mic check. */
const DETECTION_DURATION_REQUIRED = 3;
/** A short quiet gap is tolerated before the progress resets. */
const DETECTION_GRACE_PERIOD = 1;

export default function MicrophoneStep({
  session,
  onNext,
}: {
  session: RobotSessionHandle;
  onNext: () => void;
}) {
  const [trouble, setTrouble] = useState(false);
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

  const status = !isActive
    ? 'Connecting to the microphone…'
    : complete
      ? 'I heard you! Moving on…'
      : detected
        ? "Keep going! Don't stop…"
        : progress > 0
          ? "Keep rubbing! Don't stop now…"
          : 'Listening… rub my head or make some noise';

  if (trouble) {
    return (
      <TroubleshootView
        title={TROUBLE_TIPS.microphone.title}
        tips={TROUBLE_TIPS.microphone.tips}
        onBack={() => setTrouble(false)}
      />
    );
  }

  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline
        title="Can I hear you?"
        caption="Rub my head gently or say something near me - I need to check my microphone picks up sound."
      />

      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <FrequencyBars level={level} isActive={isActive} height={56} />
      </Box>

      <Box sx={{ width: '100%', maxWidth: 320 }}>
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

      <Typography
        sx={{
          fontSize: TYPO.sm,
          color: complete ? STATUS.success : 'text.secondary',
          fontWeight: complete ? FONT_WEIGHT.semibold : FONT_WEIGHT.regular,
          textAlign: 'center',
          minHeight: 20,
        }}
      >
        {status}
      </Typography>

      {!complete ? (
        <TroubleLink label="Sound doesn't work" onClick={() => setTrouble(true)} />
      ) : null}
    </Stack>
  );
}
