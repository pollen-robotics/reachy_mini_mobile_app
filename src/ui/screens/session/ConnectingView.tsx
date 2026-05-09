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
 * Same layered design system as the desktop app's startup screen:
 * a horizontal `StepsProgressIndicator` (3 dots + connecting bar +
 * pulsing animation on the current step + checkmark pop on
 * completed steps) over a primary headline + a sub-caption that
 * morphs to reflect the engine's current activity.
 *
 * Three steps:
 *
 *   ●━━━━━━━━━●━━━━━━━━━○
 *   Link       Session    Wake-up
 *
 *   - LINK     - HF auth + central handshake (pre-`starting` cluster).
 *   - SESSION  - WebRTC bring-up (`session.start()` first ~3 s).
 *   - WAKE-UP  - motors enabled + wake trajectory plays (`session.wakeUp()`).
 *
 * The Session → Wake-up advance is timer-driven (~3 s into the
 * `starting` state) because the engine doesn't emit a separate FSM
 * state for the wake-up phase - it's all part of `starting`. The
 * timer is reset whenever the FSM leaves `starting`, so a retry
 * cleanly starts from Session again.
 *
 * Retry awareness
 * ───────────────
 * When the engine kicks off a libnice-induced retry (see
 * `conversation-engine.ts::doStart`), the host passes a non-null
 * `connectionAttempt`. We:
 *   - flip the headline to "Reconnecting to your Reachy"
 *   - swap the caption to the per-attempt "Attempt n of m"
 *   - tint the stepper's active step with the primary colour
 *     (via the `accent` prop) so the whole overlay reads as
 *     "active recovery" at a glance.
 *
 * Pure presentational (with internal timers): no SDK access, no
 * engine coupling beyond the typed props.
 */
import { useEffect, useState } from 'react';
import { Stack, Typography } from '@mui/material';

import type {
  ConversationConnectionAttempt,
  ConversationState,
} from '@/features/conversation';
import StepsProgressIndicator from '@/ui/design/StepsProgressIndicator';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

interface ConnectingViewProps {
  /** Current engine state. Drives both the secondary caption and the
   *  stepper's active index. */
  state: ConversationState;
  /** In-flight retry info from `useRobotSession`. Non-null while the
   *  engine is on its second (or further) attempt at `startSession`.
   *  `null` on the first attempt, on success, or on fatal error. */
  connectionAttempt?: ConversationConnectionAttempt | null;
}

/**
 * Time spent in the `starting` state before we visually advance from
 * the SESSION step to the WAKE-UP step. Tuned to the typical timing
 * of a healthy LAN bring-up: ~1-2 s for the WebRTC handshake then
 * the wake trajectory takes over. Slightly conservative so the user
 * sees the SESSION dot "pulse and complete" rather than skipping
 * straight to WAKE-UP on a fast device.
 */
const SESSION_TO_WAKE_TRANSITION_MS = 2_500;

/**
 * After this many ms in the same `starting` state without any
 * progress signal, we surface a small "taking a moment" hint so
 * the user knows we're not stuck. Slightly under the engine's 8 s
 * per-attempt timeout so the message lands BEFORE the engine
 * decides to retry, never after.
 */
const SLOW_HINT_DELAY_MS = 6_000;

const STEPS = [
  { id: 'link', label: 'Link' },
  { id: 'session', label: 'Session' },
  { id: 'wake', label: 'Wake-up' },
] as const;

export default function ConnectingView({ state, connectionAttempt }: ConnectingViewProps) {
  const isRetrying = (connectionAttempt?.attempt ?? 1) > 1;
  const startingElapsedPastWake = useStartingElapsedPast(
    state,
    SESSION_TO_WAKE_TRANSITION_MS,
  );
  const slowHintVisible = useStartingElapsedPast(state, SLOW_HINT_DELAY_MS);

  const currentStep = stepIndexFor(state, startingElapsedPastWake);

  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={3.5}
      sx={{ flex: 1, minHeight: 0, width: '100%', px: 3 }}
    >
      {/* Stepper takes the visual lead; capped width so the dots
          stay close enough together to read as a single
          progression. The desktop component is designed to fill its
          parent, so we constrain it here at the call site. */}
      <Stack sx={{ width: '100%', maxWidth: 340 }}>
        <StepsProgressIndicator
          steps={[...STEPS]}
          currentStep={currentStep}
          accent={isRetrying}
        />
      </Stack>

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
          {captionFor({
            state,
            connectionAttempt: connectionAttempt ?? null,
            startingElapsedPastWake,
            slowHintVisible,
          })}
        </Typography>
      </Stack>
    </Stack>
  );
}

/**
 * Map the engine's pre-ready states to the 0/1/2 step index of the
 * 3-step indicator. The starting → step 1 → step 2 transition is
 * timer-driven (see `useStartingElapsedPast`) because the engine
 * doesn't model a separate "wake-up" FSM state.
 */
function stepIndexFor(state: ConversationState, pastWakeThreshold: boolean): 0 | 1 | 2 {
  switch (state) {
    case 'signed-out':
    case 'authenticated':
    case 'connecting':
    case 'connected':
    case 'auto-selecting':
      return 0;
    case 'starting':
      return pastWakeThreshold ? 2 : 1;
    default:
      return 2;
  }
}

interface CaptionInputs {
  state: ConversationState;
  connectionAttempt: ConversationConnectionAttempt | null;
  startingElapsedPastWake: boolean;
  slowHintVisible: boolean;
}

function captionFor({
  state,
  connectionAttempt,
  startingElapsedPastWake,
  slowHintVisible,
}: CaptionInputs): string {
  // Retry caption wins over everything else - the user needs to know
  // we're actively retrying, not stuck on a stale connecting message.
  if (connectionAttempt && connectionAttempt.attempt > 1) {
    return `Attempt ${connectionAttempt.attempt} of ${connectionAttempt.maxAttempts} - this can take a few seconds.`;
  }

  // Caption order reflects the user's mental model of the bring-up,
  // not the literal FSM order. Pre-starting states are collapsed
  // because the user can't perceive their distinction.
  switch (state) {
    case 'signed-out':
    case 'authenticated':
    case 'connecting':
    case 'connected':
    case 'auto-selecting':
      return 'Opening secure link to Hugging Face';
    case 'starting':
      // `starting` is the umbrella for both the WebRTC `startSession`
      // handshake and the awaited `wakeUp` trajectory. We split the
      // caption based on the same timer that drives the stepper:
      // first half says "establishing session", second half (after
      // ~2.5 s) says "waking up".
      if (slowHintVisible) {
        return 'Waking up your Reachy - taking a moment to settle in…';
      }
      return startingElapsedPastWake
        ? 'Enabling motors and waking up your Reachy'
        : 'Establishing the WebRTC session';
    default:
      // Defensive: should never render in `ready+` states because
      // the host swaps to the orb chrome there.
      return 'Almost there…';
  }
}

/**
 * Returns `true` once we've been in the `starting` state for longer
 * than `delayMs`. Resets to `false` whenever we transition out of
 * `starting`, so a retry / handoff starts a fresh countdown.
 *
 * Used twice in this component:
 *   - to advance the stepper from SESSION → WAKE-UP after ~2.5 s,
 *   - to surface the "taking a moment" hint after ~6 s.
 */
function useStartingElapsedPast(state: ConversationState, delayMs: number): boolean {
  const [past, setPast] = useState(false);

  useEffect(() => {
    if (state !== 'starting') {
      setPast(false);
      return;
    }
    const handle = window.setTimeout(() => setPast(true), delayMs);
    return () => {
      window.clearTimeout(handle);
    };
  }, [state, delayMs]);

  return past;
}
