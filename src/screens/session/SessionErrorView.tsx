/**
 * Error view rendered when the conversation engine reports a fatal
 * state, OR when the host can't even reach the engine (e.g. the
 * picked robot listing carries no peer id).
 *
 * Two CTAs - "Back" (always) and an optional "Try again" - so the
 * user can decide between giving up and re-mounting the panel. The
 * host wires the retry action; the panel itself does not own one
 * since the FSM transition out of `error` happens via the orb
 * click (engine's `triggerOrbAction` resets the state machine).
 */
import { Button, Stack, Typography } from '@mui/material';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';

import { FONT_WEIGHT, TYPO } from '../../styles/tokens';

interface SessionErrorViewProps {
  /** Headline. Defaults to a generic "Couldn't connect" line. */
  headline?: string;
  /** Optional verbatim error from the engine / SDK. Rendered in a
   * smaller secondary line. */
  message?: string | null;
  /** Wired to the primary CTA. Always present (typically the host's
   * "Back" / "Cancel" path). */
  onBack: () => void;
  /** When provided, an additional outlined "Try again" button is
   * rendered. Use it when the host knows how to re-attempt the
   * connection (e.g. by remounting the panel under a fresh key). */
  onRetry?: () => void;
}

export default function SessionErrorView({
  headline = "Couldn't connect to your Reachy",
  message,
  onBack,
  onRetry,
}: SessionErrorViewProps) {
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={2.5}
      sx={{ flex: 1, minHeight: 0, width: '100%' }}
    >
      <ErrorOutlineIcon sx={{ fontSize: 64, color: 'error.main' }} />
      <Typography
        sx={{
          fontSize: TYPO.lg,
          fontWeight: FONT_WEIGHT.semibold,
          textAlign: 'center',
        }}
      >
        {headline}
      </Typography>
      {message && (
        <Typography
          sx={{
            fontSize: TYPO.sm,
            color: 'text.secondary',
            textAlign: 'center',
            maxWidth: 320,
            wordBreak: 'break-word',
          }}
        >
          {message}
        </Typography>
      )}
      <Stack direction="row" spacing={1.5}>
        <Button variant="outlined" onClick={onBack}>
          Back
        </Button>
        {onRetry && (
          <Button variant="contained" onClick={onRetry}>
            Try again
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
