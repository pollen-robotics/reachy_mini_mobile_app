/**
 * Transition view rendered while the conversation engine is bringing
 * up the WebRTC tunnel and waking the robot.
 *
 * Maps over the engine's pre-`ready` cluster of states:
 *
 *   signed-out / authenticated / connecting / connected /
 *   auto-selecting / starting
 *
 * Visual narrative
 * ────────────────
 * One spinner, one primary line, a sub-caption that morphs to reflect
 * what the engine is currently doing, and a tiny 2-step pill stripe at
 * the bottom that fills in as we move from "secure link" to "waking
 * up". The host (`RobotSessionScreen`) owns when to mount/unmount this
 * view; we add no internal lifecycle beyond a couple of timers used
 * to surface "this is taking a moment" hints.
 *
 * Retry awareness
 * ───────────────
 * When the engine kicks off a connection retry (libnice-induced daemon
 * crash recovery: see `conversation-engine.ts::doStart`), the host
 * passes a non-null `connectionAttempt` with the new attempt number.
 * We flip the captions to "Reconnecting… (n of m)" so the user
 * understands we're actively working on it instead of staring at the
 * same frozen line for ~25 s.
 *
 * Pure presentational (with internal timers): no SDK access, no engine
 * coupling beyond the typed props.
 */
import { useEffect, useState } from 'react';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';

import type { ConversationConnectionAttempt, ConversationState } from '../../conversation';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

interface ConnectingViewProps {
  /**
   * The current engine state. Drives the secondary caption so the
   * user sees a meaningful narrative (`connecting` → `starting` →
   * `ready`) rather than a single static "Loading..." string for
   * the whole bring-up window.
   */
  state: ConversationState;
  /**
   * In-flight retry info from `useRobotSession`. Non-null while the
   * engine is on its second (or further) attempt at `startSession`.
   * `null` on the first attempt, on success, or on fatal error.
   */
  connectionAttempt?: ConversationConnectionAttempt | null;
}

/**
 * After this many ms in the same `starting` state without any
 * progress signal, we surface a small "taking a moment" hint so
 * the user knows we're not stuck. Slightly under the engine's
 * 8 s per-attempt timeout so the message lands BEFORE the engine
 * decides to retry, never after.
 */
const SLOW_HINT_DELAY_MS = 6_000;

export default function ConnectingView({ state, connectionAttempt }: ConnectingViewProps) {
  const isRetrying = (connectionAttempt?.attempt ?? 1) > 1;
  const slowHintVisible = useStartingTakingLong(state, SLOW_HINT_DELAY_MS);

  const stepIndex = stepIndexFor(state);

  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={2.5}
      sx={{ flex: 1, minHeight: 0, width: '100%', px: 3 }}
    >
      <CircularProgress
        size={42}
        thickness={3.5}
        sx={{
          color: isRetrying ? 'primary.main' : 'text.secondary',
          transition: 'color 200ms ease',
        }}
      />
      <Stack alignItems="center" spacing={0.75}>
        <Typography
          sx={{
            fontSize: TYPO.lg,
            fontWeight: FONT_WEIGHT.semibold,
            textAlign: 'center',
          }}
        >
          {isRetrying ? 'Reconnecting to your Reachy' : 'Connecting to your Reachy'}
        </Typography>
        <Typography
          sx={{
            fontSize: TYPO.sm,
            color: 'text.secondary',
            textAlign: 'center',
            maxWidth: 280,
            // Reserve a stable two-line height so the slow-hint
            // appearance doesn't shift the layout under the user.
            minHeight: '2.6em',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {captionFor({ state, connectionAttempt: connectionAttempt ?? null, slowHintVisible })}
        </Typography>
      </Stack>
      <Stepper activeIndex={stepIndex} accent={isRetrying} />
    </Stack>
  );
}

/**
 * Maps the engine's pre-ready states to a 0/1 step index. We
 * deliberately collapse the auth/connect cluster onto step 0 because
 * the user can't perceive the distinction; step 1 is reached the
 * moment the engine flips into `starting` (which is when the WebRTC
 * session handshake is in flight and the wake-up is about to fire).
 */
function stepIndexFor(state: ConversationState): 0 | 1 {
  switch (state) {
    case 'signed-out':
    case 'authenticated':
    case 'connecting':
    case 'connected':
    case 'auto-selecting':
      return 0;
    case 'starting':
    default:
      return 1;
  }
}

interface CaptionInputs {
  state: ConversationState;
  connectionAttempt: ConversationConnectionAttempt | null;
  slowHintVisible: boolean;
}

function captionFor({ state, connectionAttempt, slowHintVisible }: CaptionInputs): string {
  // Retry caption wins over everything else - the user needs to know
  // we're actively retrying, not stuck on a stale connecting message.
  if (connectionAttempt && connectionAttempt.attempt > 1) {
    return `Attempt ${connectionAttempt.attempt} of ${connectionAttempt.maxAttempts} - this can take a few seconds.`;
  }

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
      // Slow-hint append once we've been here for a while.
      return slowHintVisible
        ? 'Waking up your Reachy - taking a moment to settle in…'
        : 'Enabling motors and waking up your Reachy';
    default:
      // Defensive: should never render in `ready+` states because
      // the host swaps to the orb chrome there.
      return 'Almost there…';
  }
}

/**
 * Tracks whether we've been in the `starting` state for longer than
 * `delayMs`. Resets to `false` whenever we transition out of the
 * `starting` cluster. Used to gate the "this is taking a moment"
 * caption so it never flashes during a fast handshake (the typical
 * 1-3 s LAN case).
 */
function useStartingTakingLong(state: ConversationState, delayMs: number): boolean {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (state !== 'starting') {
      setSlow(false);
      return;
    }
    const handle = window.setTimeout(() => setSlow(true), delayMs);
    return () => {
      window.clearTimeout(handle);
    };
  }, [state, delayMs]);

  return slow;
}

/**
 * Two-step pill stripe rendered below the caption to give the user a
 * tangible sense of progress through the bring-up phases.
 *
 * Visuals
 * ───────
 * - The active step pulses (subtle scale + opacity loop).
 * - Past steps are filled solid in the primary tint.
 * - Future steps are dim divider strokes.
 * - When `accent` is true (retry in progress), the active step uses
 *   the primary tint instead of `text.secondary` so the whole
 *   overlay reads as "active recovery" at a glance.
 */
function Stepper({ activeIndex, accent }: { activeIndex: 0 | 1; accent: boolean }) {
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{ pt: 0.5 }}
      role="progressbar"
      aria-label="Connection progress"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={activeIndex}
    >
      {[0, 1].map((idx) => {
        const isActive = idx === activeIndex;
        const isPast = idx < activeIndex;
        return (
          <Box
            key={idx}
            sx={{
              width: 28,
              height: 4,
              borderRadius: 2,
              backgroundColor: (theme) => {
                if (isPast) return theme.palette.primary.main;
                if (isActive) return accent ? theme.palette.primary.main : theme.palette.text.secondary;
                return theme.palette.divider;
              },
              opacity: isActive ? 1 : isPast ? 0.85 : 0.6,
              animation: isActive ? 'connectingStepPulse 1.4s ease-in-out infinite' : 'none',
              transition: 'background-color 200ms ease, opacity 200ms ease',
              '@keyframes connectingStepPulse': {
                '0%': { opacity: 0.55 },
                '50%': { opacity: 1 },
                '100%': { opacity: 0.55 },
              },
            }}
          />
        );
      })}
    </Stack>
  );
}
