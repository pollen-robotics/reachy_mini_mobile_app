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
 *   - SESSION  - WebRTC bring-up (`session.start()` is in flight).
 *   - WAKE-UP  - motors enabled + wake trajectory plays (`session.wakeUp()`).
 *
 * The Session → Wake-up advance is EVENT-driven, not timer-driven:
 * `connectionAttempt` is non-null while `session.start()` runs (the
 * engine fires the callback with `{ attempt }` at the start of each
 * try and with `null` right after success), so we can map:
 *
 *   - `connectionAttempt != null` AND state == `starting`  →  Session
 *   - `connectionAttempt == null` AND state == `starting`  →  Wake-up
 *
 * This way the indicator advances precisely on the boundary between
 * the two SDK calls instead of on a timer that often misses the
 * wake-up phase entirely on a fast LAN handshake (1-2 s).
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
import { Box, Stack, Typography } from '@mui/material';

import connectionUrl from '@/assets/connection.svg';
import type { ConversationConnectionAttempt, ConnectionState } from '@/features/conversation';
import StepsProgressIndicator from '@/ui/design/StepsProgressIndicator';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

interface ConnectingViewProps {
  /** Current connection state. Drives both the secondary caption and
   *  the stepper's active index. */
  state: ConnectionState;
  /** In-flight retry info from `useRobotSession`. Non-null while the
   *  engine is on its second (or further) attempt at `startSession`.
   *  `null` on the first attempt, on success, or on fatal error. */
  connectionAttempt?: ConversationConnectionAttempt | null;
}

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
  const attempt = connectionAttempt ?? null;
  const isRetrying = (attempt?.attempt ?? 1) > 1;
  // Sticky "we've reached the wake-up phase" flag. The engine fires
  // `connectionAttempt = null` at the boundary between `session.start()`
  // resolving and `session.wakeUp()` starting, so the moment we observe
  // `state === 'starting'` AND `attempt === null` we know we're in the
  // wake phase. We latch the bit (instead of computing it on each
  // render) so a brief async race during the FSM transition to `ready`
  // can't blink us back to "Session" while the indicator unmounts.
  const inWakePhase = useReachedWakePhase(state, attempt);
  const slowHintVisible = useStartingElapsedPast(state, SLOW_HINT_DELAY_MS);

  const currentStep = stepIndexFor(state, inWakePhase);

  useEffect(() => {
    console.log(
      `[DIAG][ConnectingView] render state=${state} attempt=${
        attempt ? `${attempt.attempt}/${attempt.maxAttempts}` : 'null'
      } inWakePhase=${inWakePhase} currentStep=${currentStep}`
    );
  }, [state, attempt, inWakePhase, currentStep]);

  useEffect(() => {
    console.log('[DIAG][ConnectingView] MOUNT');
    return () => console.log('[DIAG][ConnectingView] UNMOUNT');
  }, []);

  return (
    <Stack
      spacing={3.5}
      sx={{
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        minHeight: 0,
        width: '100%',
        px: 3,
      }}
    >
      {/* Illustration anchors the view above the stepper, mirroring
          the visual identity used by `SessionErrorView`. Hidden from
          assistive tech: the headline + caption already convey the
          state. */}
      <Box
        sx={{
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <Box
          component="img"
          src={connectionUrl}
          alt=""
          aria-hidden
          sx={{
            width: 144,
            height: 144,
            display: 'block',
          }}
        />
      </Box>
      {/* Stepper takes the visual lead; capped width so the dots
          stay close enough together to read as a single
          progression. The desktop component is designed to fill its
          parent, so we constrain it here at the call site. */}
      <Stack sx={{ width: '100%', maxWidth: 340 }}>
        <StepsProgressIndicator steps={[...STEPS]} currentStep={currentStep} accent={isRetrying} />
      </Stack>
      <Stack
        spacing={0.75}
        sx={{
          alignItems: 'center',
        }}
      >
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
            // Reserve a FIXED two-line box (line-height × 2) so a caption
            // wrapping from one to two lines never changes the block's
            // height - otherwise the Y-centred layout shifts under the
            // user. `2.6em` was just shy of two real lines, so 2-line
            // captions (retry / slow hint) still nudged it.
            lineHeight: 1.4,
            height: '2.8em',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {captionFor({
            state,
            connectionAttempt: attempt,
            inWakePhase,
            slowHintVisible,
          })}
        </Typography>
      </Stack>
    </Stack>
  );
}

/**
 * Map the engine's pre-ready states to the 0/1/2 step index of the
 * 3-step indicator. The starting → Session → Wake-up advance is
 * EVENT-driven (see `useReachedWakePhase`) because the engine
 * fires `connectionAttempt = null` exactly between `session.start()`
 * resolving and `session.wakeUp()` starting.
 */
function stepIndexFor(state: ConnectionState, inWakePhase: boolean): 0 | 1 | 2 {
  switch (state) {
    case 'signed-out':
    case 'authenticated':
    case 'connecting':
    case 'connected':
    case 'selecting':
      return 0;
    case 'starting':
      return inWakePhase ? 2 : 1;
    default:
      return 2;
  }
}

interface CaptionInputs {
  state: ConnectionState;
  connectionAttempt: ConversationConnectionAttempt | null;
  inWakePhase: boolean;
  slowHintVisible: boolean;
}

function captionFor({
  state,
  connectionAttempt,
  inWakePhase,
  slowHintVisible,
}: CaptionInputs): string {
  // Retry caption wins over everything else - the user needs to know
  // we're actively retrying, not stuck on a stale connecting message.
  // Kept short so it stays on a single line (the headline already says
  // "Reconnecting"); a longer copy wrapped to 2 lines and shifted the
  // Y-centred block.
  if (connectionAttempt && connectionAttempt.attempt > 1) {
    return `Attempt ${connectionAttempt.attempt} of ${connectionAttempt.maxAttempts}…`;
  }

  // Caption order reflects the user's mental model of the bring-up,
  // not the literal FSM order. Pre-starting states are collapsed
  // because the user can't perceive their distinction.
  switch (state) {
    case 'signed-out':
    case 'authenticated':
    case 'connecting':
    case 'connected':
    case 'selecting':
      return 'Opening secure link to Hugging Face';
    case 'starting':
      // `starting` is the umbrella for both `session.start()` (the
      // WebRTC handshake) and `session.wakeUp()` (the trajectory).
      // We split the caption on the SAME signal that drives the
      // stepper: `connectionAttempt` is non-null during start(),
      // null during wakeUp().
      if (slowHintVisible) {
        return 'Waking up your Reachy - just a moment…';
      }
      return inWakePhase
        ? 'Enabling motors and waking up your Reachy'
        : 'Establishing the WebRTC session';
    default:
      // Defensive: should never render in `ready+` states because
      // the host swaps to the orb chrome there.
      return 'Almost there…';
  }
}

/**
 * Returns `true` once we've observed the boundary between
 * `session.start()` resolving and `session.wakeUp()` starting -
 * i.e. while `state === 'starting'` we saw `connectionAttempt`
 * flip from non-null to null.
 *
 * The bit is sticky for the duration of the current `starting`
 * window: once latched, a brief race between the engine's `setState
 * ('ready')` and the host's React render can't blink us back to the
 * Session step before the indicator unmounts.
 *
 * Resets to `false` whenever the FSM leaves `starting`, so a
 * subsequent connection cycle (after `tearDown` + new mount, or
 * after a release+reacquire) starts fresh from the Session step.
 */
function useReachedWakePhase(
  state: ConnectionState,
  connectionAttempt: ConversationConnectionAttempt | null
): boolean {
  const [reached, setReached] = useState(false);

  useEffect(() => {
    if (state !== 'starting') {
      // We're either pre-starting or post-`ready`; reset so the next
      // cycle through `starting` starts from the Session step again.
      setReached(false);
      return;
    }
    if (!connectionAttempt) {
      // We're in `starting` with no attempt in flight → the engine
      // either hasn't fired the first `onConnectionAttempt` yet, or
      // it just fired `null` because `session.start()` resolved and
      // `session.wakeUp()` is about to run. The first case is a sub-
      // millisecond race; the second is the boundary we care about.
      // Latch the bit and keep it through the rest of the `starting`
      // window (we never want to go back to Session once we've
      // reached Wake-up - the visual would feel glitchy).
      setReached(true);
    }
  }, [state, connectionAttempt]);

  return reached;
}

/**
 * Returns `true` once we've been in the `starting` state for longer
 * than `delayMs`. Resets to `false` whenever we transition out of
 * `starting`. Used to surface the "taking a moment" hint after ~6 s,
 * never to drive the stepper itself.
 */
function useStartingElapsedPast(state: ConnectionState, delayMs: number): boolean {
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
