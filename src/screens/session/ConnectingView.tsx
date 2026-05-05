/**
 * Transition view rendered while the conversation engine is bringing
 * up the WebRTC tunnel and waking the robot.
 *
 * Maps over the engine's pre-`ready` cluster of states:
 *
 *   signed-out / authenticated / connecting / connected /
 *   auto-selecting / starting
 *
 * Visually unified - one large spinner + a primary line + a small
 * sub-line that morphs to reflect what the engine is currently
 * doing. The user sees "Enabling motors..." during `starting`
 * (which is when `setMotorMode('enabled')` and `wakeUp()` fire over
 * the DataChannel inside the engine), then "Waking up..." while the
 * trajectory plays, and the overlay disappears once the engine flips
 * to `ready`.
 *
 * Pure presentational component: no SDK access, no state of its own.
 * The host (`RobotSessionScreen`) owns the conditions for showing
 * and hiding it.
 */
import { CircularProgress, Stack, Typography } from '@mui/material';

import type { ConversationState } from '../../conversation';
import { FONT_WEIGHT, TYPO } from '../../styles/tokens';

interface ConnectingViewProps {
  /**
   * The current engine state. Drives the secondary caption so the
   * user sees a meaningful narrative (`connecting` → `starting` →
   * `ready`) rather than a single static "Loading..." string for
   * the whole bring-up window.
   */
  state: ConversationState;
}

export default function ConnectingView({ state }: ConnectingViewProps) {
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={2.5}
      sx={{ flex: 1, minHeight: 0, width: '100%' }}
    >
      <CircularProgress size={56} thickness={3.5} />
      <Typography
        sx={{
          fontSize: TYPO.lg,
          fontWeight: FONT_WEIGHT.semibold,
          textAlign: 'center',
        }}
      >
        Connecting to your Reachy
      </Typography>
      <Typography
        sx={{
          fontSize: TYPO.sm,
          color: 'text.secondary',
          textAlign: 'center',
          maxWidth: 280,
        }}
      >
        {captionForState(state)}
      </Typography>
    </Stack>
  );
}

function captionForState(state: ConversationState): string {
  // Caption order reflects the user's mental model of the bring-up,
  // not the literal FSM order. We deliberately collapse the early
  // auth/connect states onto a single "Opening secure link" line
  // because their distinction is invisible to the user.
  switch (state) {
    case 'signed-out':
    case 'authenticated':
    case 'connecting':
    case 'connected':
    case 'auto-selecting':
      return 'Opening secure link to Hugging Face';
    case 'starting':
      // `starting` is when the engine is in the middle of
      // `startSession()` + the awaited `wakeUp()` (motors get
      // enabled and the wake animation plays inside this window
      // - see `conversation-engine.ts` after `setState("starting")`).
      return 'Enabling motors and waking up your Reachy';
    default:
      // Defensive: should never render in `ready+` states because
      // the host swaps to the orb chrome there.
      return 'Almost there…';
  }
}
