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

import type { ConversationConnectionAttempt } from '@/features/conversation';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

interface ReconnectingViewProps {
  /** In-flight retry info from `useRobotSession`. Non-null while the
   *  engine is on its second (or further) `startSession` attempt. */
  connectionAttempt?: ConversationConnectionAttempt | null;
}

export default function ReconnectingView({ connectionAttempt }: ReconnectingViewProps) {
  const attempt = connectionAttempt ?? null;
  const caption =
    attempt && attempt.attempt > 1
      ? `Attempt ${attempt.attempt} of ${attempt.maxAttempts}…`
      : 'Restoring the session…';

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
      <CircularProgress size={28} thickness={4} />
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
            // Fixed one-line box so the attempt caption swapping in
            // doesn't nudge the Y-centred block (same trick as
            // ConnectingView's two-line reservation).
            lineHeight: 1.4,
            height: '1.4em',
          }}
        >
          {caption}
        </Typography>
      </Stack>
    </Stack>
  );
}
