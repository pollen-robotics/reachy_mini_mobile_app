/**
 * Conversation panel.
 *
 * Pure consumer of a `RobotSessionHandle`: this panel renders the
 * orb + caption + side buttons + tool-call toast, but **does not own
 * the engine lifecycle**. The engine is mounted and torn down by the
 * `useRobotSession` hook upstream (in `RobotSessionScreen`).
 *
 * Why this split exists
 * ─────────────────────
 * In the previous architecture, the panel owned `mountConversation`
 * directly via `chainLifecycle`. That coupled the engine teardown to
 * the panel's React lifecycle, which meant any unmount of the panel
 * (e.g. tab switch, conditional rendering) implicitly tore down the
 * WebRTC session AND the robot's physical state (gotoSleep, motors
 * disabled). The new screen has multiple consumers of the same robot
 * (the conversation orb + the embedded apps iframe) that should NOT
 * trigger a robot sleep when one of them goes away. Hoisting the
 * engine to a session hook breaks that coupling cleanly.
 *
 * Responsibilities (D layer)
 * ──────────────────────────
 *   - Render the orb chrome + caption + side buttons + toast based
 *     on `session.engineState`.
 *   - Wire user gestures (tap orb, mute, stop) to the session
 *     methods (`triggerOrbAction`, `setMicMuted`, `requestStop`).
 *
 * Not responsibilities (A + B + C layers - moved to `useRobotSession`)
 * ──────────────────────────────────────────────────────────────────
 *   - Mount / unmount `mountConversation`.
 *   - Decide when to start / stop the WebRTC session.
 *   - Decide when to put the robot to sleep.
 *
 * The audio level CSS-vars target (the orb root element) is owned by
 * THIS panel via a ref forwarded back to the session through
 * `audioLevelsTargetRef` on the host side.
 */
import { Box, Stack } from '@mui/material';
import { type RefObject } from 'react';

import { ConversationOrb, type OrbState } from './orb/ConversationOrb';
import { ConversationCaption } from './orb/ConversationCaption';
import {
  MuteSideButton,
  StopSideButton,
} from './orb/ConversationSideButtons';
import { ConversationToolToast } from './orb/ConversationToolToast';
import type { AppState } from '@/features/conversation/engine/conversation-engine';
import type { RobotSessionHandle } from '@/features/session/useRobotSession';

export interface ConversationPanelProps {
  /**
   * Session handle from `useRobotSession`. The panel reads
   * `engineState`, `errorMessage`, `micMuted`, `toolToastLabel`
   * from here and forwards user gestures to the session methods.
   */
  session: RobotSessionHandle;
  /**
   * Ref to attach to the orb's clickable root. The session hook
   * uses this same ref as `audioLevelsTarget` for the engine's
   * level monitors, so the orb's CSS variables animate in sync
   * with the audio. Lifted to the host so it can be wired to both
   * sides without a circular dependency.
   */
  orbRef: RefObject<HTMLButtonElement | null>;
}

export function ConversationPanel({
  session,
  orbRef,
}: ConversationPanelProps) {
  const orbState = mapAppStateToOrb(session.engineState);
  const live =
    session.engineState === 'listening' ||
    session.engineState === 'user-speaking' ||
    session.engineState === 'processing' ||
    session.engineState === 'ai-speaking';

  const handleToggleMute = (): void => {
    session.setMicMuted(!session.micMuted);
  };

  /**
   * Tap on the orb's stop side button.
   *
   * Drops the conversation parts (D layer) only - OpenAI client,
   * antennas oscillator, head wobbler, audio monitors. The WebRTC
   * session stays up, motors stay enabled, the robot stays awake.
   * The engine parks back in `ready` so the user can tap the orb
   * again to restart conversation without going through the
   * connecting overlay.
   *
   * Distinct from the back / power-off button at the top of the
   * screen, which triggers `session.tearDown()` (full A+B+C+D
   * teardown + navigate away).
   */
  const handleStop = (): void => {
    void session.stopConversation().catch((err) => {
      console.warn('[conversation-panel] stopConversation threw:', err);
    });
  };

  const handleOrbClick = (): void => {
    void session.triggerOrbAction().catch((err) => {
      console.warn('[conversation-panel] triggerOrbAction threw:', err);
    });
  };

  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={2}
      sx={{
        flex: 1,
        minHeight: 0,
        width: '100%',
        position: 'relative',
        py: 4,
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="center"
        spacing={1.25}
      >
        <MuteSideButton
          live={live}
          micMuted={session.micMuted}
          onToggleMute={handleToggleMute}
        />
        <ConversationOrb
          state={orbState}
          audioRef={orbRef}
          ariaLabel="Conversation"
          onClick={handleOrbClick}
        />
        <StopSideButton live={live} onStop={handleStop} />
      </Stack>
      <ConversationCaption state={orbState} message={session.errorMessage} />
      <ConversationToolToast label={session.toolToastLabel} />

      {/* The engine-host inert div used to live here for legacy
          API compat with `mountConversation(root, opts)`. The hook
          now creates its own detached root so the panel doesn't
          need to expose any DOM to the engine. */}
      <Box
        aria-hidden="true"
        sx={{ display: 'none' }}
      />
    </Stack>
  );
}

/**
 * Collapse the engine's full state machine onto the smaller visual
 * vocabulary the orb knows. `released` maps to `idle` so the orb
 * shows a neutral state during a handoff (the panel is typically
 * hidden at that point but we keep the mapping defensive).
 *
 * Exported for unit testing.
 */
export function mapAppStateToOrb(state: AppState): OrbState {
  switch (state) {
    case 'connecting':
    case 'starting':
    case 'auto-selecting':
      return 'connecting';
    case 'ready':
      return 'ready';
    case 'listening':
      return 'listening';
    case 'user-speaking':
      return 'user-speaking';
    case 'processing':
      return 'processing';
    case 'ai-speaking':
      return 'ai-speaking';
    case 'error':
      return 'error';
    case 'signed-out':
    case 'authenticated':
    case 'connected':
    case 'released':
    default:
      return 'idle';
  }
}
