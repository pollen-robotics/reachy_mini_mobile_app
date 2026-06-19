/**
 * Error card rendered when the conversation engine reports a fatal
 * state, OR when the host can't even reach the engine (e.g. the
 * picked robot listing carries no peer id).
 *
 * Visual identity
 * ───────────────
 * Card-less error surface built on the shared `IllustratedState`
 * layout (hero illustration + title + message + actions), sitting
 * directly on the panel background so it reads as a calm in-place
 * state rather than a modal sheet. Using the canonical block keeps its
 * illustration size + type scale aligned with the app's other
 * full-screen states (empty launcher, update gate, wizard).
 *
 * The host wires the retry / back actions; the view itself does
 * not own a state machine. Two CTAs:
 *   - "Back"  (always)  - hand off to the host's exit path.
 *   - "Try again" (optional) - re-attempt the connection. Rendered
 *     when `onRetry` is provided; useful on the host side when it
 *     knows how to reset the engine (typically by re-mounting the
 *     panel under a fresh key).
 */
import { Button, Stack } from '@mui/material';

import connectionLostUrl from '@/assets/connection-lost.svg';
import IllustratedState from '@/ui/design/IllustratedState';

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
      sx={{
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        minHeight: 0,
        width: '100%',
        px: 1,
        py: 2,
      }}
    >
      {/* Reachy "connection lost" illustration sourced from the desktop
          app's asset library so the visual identity stays consistent
          across the two clients. */}
      <IllustratedState
        illustration={connectionLostUrl}
        title={headline}
        description={message ?? undefined}
      >
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'center' }}>
          <Button
            variant="outlined"
            color="primary"
            onClick={onBack}
            sx={{
              // Radius / text-transform / weight come from the theme's
              // generic `MuiButton` styles (RADIUS = 12px); only the
              // thicker outline + sizing are local.
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
                // Radius / text-transform / weight inherited from the
                // theme's generic `MuiButton` styles.
                flex: 1,
                maxWidth: 140,
              }}
            >
              Try again
            </Button>
          ) : null}
        </Stack>
      </IllustratedState>
    </Stack>
  );
}
