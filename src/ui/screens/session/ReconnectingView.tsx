/**
 * Compact reconnection overlay.
 *
 * Shown when the session is being brought BACK on a screen the user
 * already knows: returning from an iframe handoff (`reacquiring`) or
 * an in-place recovery after a transport-level fatal (`recovering`).
 *
 * Deliberately minimal - a spinner and one line of copy. The full
 * `ConnectingView` (illustration + Link/Session/Wake-up stepper) is
 * reserved for the INITIAL bring-up, where the user has no context
 * yet and the pipeline narrative earns its screen space. Replaying
 * that pipeline on every app-exit read as "the app is reconnecting
 * from scratch", which is exactly the impression we want to avoid:
 * these paths restore an existing relationship, they don't build a
 * new one.
 */
import { CircularProgress, Stack, Typography } from '@mui/material';

import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

export default function ReconnectingView() {
  // No attempt counter here on purpose: "Attempt 2 of 2" reads as a
  // countdown to failure and adds anxiety without giving the user
  // anything actionable. One calm, constant line is enough - if the
  // retries run out, the error view takes over anyway.
  const caption = 'This should only take a few seconds…';

  return (
    <Stack
      spacing={2.5}
      sx={{
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        minHeight: 0,
        width: '100%',
        px: 3,
      }}
    >
      {/* Grey, not primary: same neutral treatment as the tab-switch
          cover's spinner. Primary is reserved for actionable accents;
          a passive wait state shouldn't pull that much attention. */}
      <CircularProgress size={28} thickness={4} sx={{ color: 'grey.300' }} />
      <Stack spacing={0.5} sx={{ alignItems: 'center' }}>
        <Typography
          sx={{
            fontSize: TYPO.lg,
            fontWeight: FONT_WEIGHT.semibold,
            textAlign: 'center',
          }}
        >
          Reconnecting to your Reachy
        </Typography>
        <Typography
          sx={{
            fontSize: TYPO.sm,
            color: 'text.secondary',
            textAlign: 'center',
            lineHeight: 1.4,
          }}
        >
          {caption}
        </Typography>
      </Stack>
    </Stack>
  );
}
