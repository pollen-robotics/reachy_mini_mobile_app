/**
 * Error card rendered when the conversation engine reports a fatal
 * state, OR when the host can't even reach the engine (e.g. the
 * picked robot listing carries no peer id).
 *
 * Visual identity
 * ───────────────
 * Centred outlined Paper card with the "connection-lost" Reachy
 * illustration on top. The card is intentionally inset from the
 * screen edges (margin around it) so it reads as a focused,
 * standalone error surface rather than a full-screen overlay -
 * matches the visual register of native iOS / macOS error sheets.
 *
 * The host wires the retry / back actions; the card itself does
 * not own a state machine. Two CTAs:
 *   - "Back"  (always)  - hand off to the host's exit path.
 *   - "Try again" (optional) - re-attempt the connection. Rendered
 *     when `onRetry` is provided; useful on the host side when it
 *     knows how to reset the engine (typically by re-mounting the
 *     panel under a fresh key).
 */
import { Box, Button, Paper, Stack, Typography } from '@mui/material';

import connectionLostUrl from '../../assets/connection-lost.svg';
import { FONT_WEIGHT, RADIUS, TYPO } from '../../styles/tokens';

interface SessionErrorViewProps {
  /** Headline. Defaults to "Reachy connection lost". */
  headline?: string;
  /** Optional verbatim error from the engine / SDK. Rendered in a
   *  smaller secondary line. */
  message?: string | null;
  /** Wired to the primary CTA. Always present (typically the host's
   *  "Back" / "Cancel" path). */
  onBack: () => void;
  /** When provided, an additional outlined "Try again" button is
   *  rendered. */
  onRetry?: () => void;
}

export default function SessionErrorView({
  headline = 'Reachy connection lost',
  message,
  onBack,
  onRetry,
}: SessionErrorViewProps) {
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      sx={{
        flex: 1,
        minHeight: 0,
        width: '100%',
        // Outer breathing room so the Paper card doesn't kiss the
        // screen edges on small viewports. The host places us inside
        // a `px: 3` column already; this adds a vertical margin and
        // a touch of extra horizontal margin for the card itself.
        px: 1,
        py: 2,
      }}
    >
      <Paper
        variant="outlined"
        sx={theme => ({
          width: '100%',
          maxWidth: 340,
          p: 3,
          pt: 2.5,
          borderRadius: `${RADIUS.xl}px`,
          borderColor: theme.palette.divider,
          // Subtle elevation cue without resorting to a shadow stack
          // (which would feel too "modal" for a contextual error).
          bgcolor: 'background.paper',
          boxShadow:
            theme.palette.mode === 'dark'
              ? '0 8px 24px rgba(0, 0, 0, 0.35)'
              : '0 8px 24px rgba(0, 0, 0, 0.06)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 2,
        })}
      >
        {/* Reachy "connection lost" illustration. Sourced from the
         * desktop app's asset library so the visual identity stays
         * consistent across the two clients. The crop has plenty of
         * built-in whitespace, so a fixed height + auto width inside
         * a centred row is enough - no need to mess with object-fit. */}
        <Box
          sx={{
            width: '100%',
            display: 'flex',
            justifyContent: 'center',
            mb: 0.5,
          }}
        >
          <Box
            component="img"
            src={connectionLostUrl}
            alt=""
            aria-hidden
            sx={{
              width: 144,
              height: 144,
              display: 'block',
            }}
          />
        </Box>

        <Typography
          component="h2"
          sx={{
            fontSize: TYPO.xl,
            fontWeight: FONT_WEIGHT.bold,
            textAlign: 'center',
            letterSpacing: '-0.2px',
            color: 'text.primary',
            m: 0,
          }}
        >
          {headline}
        </Typography>

        {message ? (
          <Typography
            sx={{
              fontSize: TYPO.sm,
              color: 'text.secondary',
              textAlign: 'center',
              wordBreak: 'break-word',
              lineHeight: 1.5,
            }}
          >
            {message}
          </Typography>
        ) : null}

        <Stack
          direction="row"
          spacing={1}
          sx={{ width: '100%', mt: 1, justifyContent: 'center' }}
        >
          <Button
            variant="outlined"
            color="primary"
            onClick={onBack}
            sx={{
              textTransform: 'none',
              fontWeight: FONT_WEIGHT.semibold,
              borderRadius: 2,
              borderWidth: 1.5,
              flex: 1,
              maxWidth: 140,
              '&:hover': { borderWidth: 1.5 },
            }}
          >
            Back
          </Button>
          {onRetry ? (
            <Button
              variant="contained"
              color="primary"
              onClick={onRetry}
              disableElevation
              sx={{
                textTransform: 'none',
                fontWeight: FONT_WEIGHT.semibold,
                borderRadius: 2,
                flex: 1,
                maxWidth: 140,
              }}
            >
              Try again
            </Button>
          ) : null}
        </Stack>
      </Paper>
    </Stack>
  );
}
