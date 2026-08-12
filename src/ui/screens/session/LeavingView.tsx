/**
 * Transition view rendered while the host is tearing the session
 * down (user tapped power-off / back).
 *
 * The actual sequence runs inside the engine's `unmount()`:
 *
 *   1. stop HF realtime + audio analysers + motion oscillators
 *   2. play the goto-sleep trajectory (DataChannel command, ~2 s)
 *   3. release motor torque (`setMotorMode('disabled')`)
 *   4. `stopSession()` (central is told the session ended)
 *   5. `disconnect()` (release the SSE)
 *
 * The host awaits `flushEngineLifecycle()` before navigating away,
 * so this view stays visible for the full duration. Pure
 * presentational, no state of its own.
 *
 * Visual posture
 * ──────────────
 * Mirrors `<ConnectingView>`'s anatomy (stack centered on the
 * vertical axis, primary visual on top, title below) so the
 * leave-screen reads as the symmetric counterpart of the join-
 * screen. But where Connecting carries a 3-dot stepper + bold
 * headline + a multi-line caption to narrate a multi-phase
 * bring-up, Leaving is intentionally one beat lighter:
 *
 *   - a small, low-contrast spinner instead of the stepper
 *     (the user already decided to leave - we don't need to
 *     dramatise the wait),
 *   - a single short headline, no caption (the goto-sleep
 *     trajectory is short enough that a sub-line of explanation
 *     reads as filler by the time it lands).
 *
 * The trailing ellipsis on the headline is enough of a
 * "something's still happening" cue without needing a second line
 * of copy. Avoids the pre-redesign "drama screen" feeling where
 * leaving felt heavier than entering.
 */
import { CircularProgress, Stack, Typography } from '@mui/material';

import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

export default function LeavingView() {
  return (
    <Stack
      spacing={2}
      sx={{
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        minHeight: 0,
        width: '100%',
        px: 3,
      }}
    >
      {/* Same 32px grey spinner as the app's other full-screen wait
          states (tab-switch cover, apps loading, setup busy views) so
          every "please wait" beat shares one visual voice.
          `text.secondary` colouring keeps it muted against both light
          and dark backgrounds. */}
      <CircularProgress size={32} sx={{ color: 'text.secondary' }} />
      <Typography
        sx={{
          fontSize: TYPO.md,
          fontWeight: FONT_WEIGHT.medium,
          color: 'text.primary',
          textAlign: 'center',
          letterSpacing: '-0.1px',
        }}
      >
        Putting Reachy to sleep…
      </Typography>
    </Stack>
  );
}
