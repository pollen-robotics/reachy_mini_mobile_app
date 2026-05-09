/**
 * Transition view rendered while the host is tearing the session
 * down (user tapped power-off / stop).
 *
 * The actual sequence runs inside the engine's `unmount()`:
 *
 *   1. stop OpenAI Realtime + audio analysers + motion oscillators
 *   2. play the goto-sleep trajectory (DataChannel command, ~2 s)
 *   3. release motor torque (`setMotorMode('disabled')`)
 *   4. `stopSession()` (central is told the session ended)
 *   5. `disconnect()` (release the SSE)
 *
 * The host awaits `flushEngineLifecycle()` before navigating away,
 * so this view stays visible for the full duration. Pure
 * presentational, no state of its own.
 */
import { CircularProgress, Stack, Typography } from '@mui/material';

import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

export default function LeavingView() {
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={2.5}
      sx={{ flex: 1, minHeight: 0, width: '100%' }}
    >
      <CircularProgress size={42} thickness={3.5} sx={{ color: 'text.secondary' }} />
      <Typography
        sx={{
          fontSize: TYPO.lg,
          fontWeight: FONT_WEIGHT.semibold,
          textAlign: 'center',
        }}
      >
        Putting your Reachy to sleep
      </Typography>
      <Typography
        sx={{
          fontSize: TYPO.sm,
          color: 'text.secondary',
          textAlign: 'center',
          maxWidth: 280,
        }}
      >
        Playing the goto-sleep animation and disabling motors
      </Typography>
    </Stack>
  );
}
