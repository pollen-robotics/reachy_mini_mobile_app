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

import sleepingReachyUrl from '@/assets/sleeping-reachy.svg';
import IllustratedState from '@/ui/design/IllustratedState';

interface SessionErrorViewProps {
  /** Headline. Defaults to "Connection interrupted" - deliberately
   *  matter-of-fact: by the time this view renders, the automatic
   *  in-place recovery already failed, and an alarmist "lost!"
   *  headline adds anxiety without adding information. */
  headline?: string;
  /** Optional verbatim error from the engine / SDK. Rendered in a
   *  smaller secondary line. */
  message?: string | null;
  /** Wired to the "Back" CTA. Always present (typically the host's
   *  "Back" / "Cancel" path). */
  onBack: () => void;
  /** When provided, an additional outlined "Try again" button is
   *  rendered. */
  onRetry?: () => void;
}

export default function SessionErrorView({
  headline = 'Connection interrupted',
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
      {/* Sleeping Reachy rather than the dead-eyed "connection lost"
          artwork: when the link drops, the daemon's idle reset really
          does put the robot to sleep, so this is both honest and far
          less alarming than X-eyes + a severed cable. */}
      <IllustratedState
        illustration={sleepingReachyUrl}
        title={headline}
        description={message ?? undefined}
      >
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'center' }}>
          {/* "Back" is the escape hatch, not the suggested action, so it
              is grey; "Try again" (when offered) carries the primary
              tint. `whiteSpace: nowrap` + no maxWidth: the labels must
              never wrap - a two-line button reads as broken. */}
          <Button
            variant="outlined"
            color="inherit"
            onClick={onBack}
            sx={{
              // Radius / text-transform / weight come from the theme's
              // generic `MuiButton` styles (RADIUS = 12px); only the
              // thicker outline + sizing are local.
              color: 'text.secondary',
              borderColor: 'divider',
              borderWidth: 1.5,
              px: 3,
              whiteSpace: 'nowrap',
              '&:hover': { borderWidth: 1.5, borderColor: 'text.secondary' },
            }}
          >
            Back
          </Button>
          {onRetry ? (
            <Button
              variant="outlined"
              color="primary"
              onClick={onRetry}
              sx={{
                borderWidth: 1.5,
                px: 3,
                whiteSpace: 'nowrap',
                '&:hover': { borderWidth: 1.5 },
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
