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
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { ConversationOrb, type OrbState } from './orb/ConversationOrb';
import { ConversationCaption } from './orb/ConversationCaption';
import {
  MuteSideButton,
  StopSideButton,
} from './orb/ConversationSideButtons';
import { ConversationToolToast } from './orb/ConversationToolToast';
import type { AppState } from '@/features/conversation/engine/conversation-engine';
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { useActivePersonality } from '@/features/personalities';
import { PersonalityGrid, PersonalityPill } from '@/ui/widgets/personality-pill';

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

  // Active personality is consumed for its `id` only: when the user
  // picks a new persona via the grid, the engine reads the active
  // personality lazily on every reconnect (see `composeInstructions`
  // and the `voice` getter in `conversation-engine.ts`), so all we
  // need to do here is restart the conversation parts when a switch
  // happens mid-call.
  const activePersonalityId = useActivePersonality().id;

  // Personality picker open / closed. When open, the body slot
  // below the sub-header swaps from the orb area to a grid of
  // persona cards (see PersonalityGrid). The hero band's chevron
  // mirrors this state via its `open` prop.
  //
  // We deliberately auto-close the picker when a conversation
  // becomes live: an OpenAI session firing while the user is still
  // browsing the picker would feel like the app skipped a beat.
  // Same idea on engine errors - the user needs to see the orb's
  // error state, not a stale picker.
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    if (!pickerOpen) return;
    if (live || session.engineState === 'error') setPickerOpen(false);
  }, [pickerOpen, live, session.engineState]);

  const togglePicker = useCallback(() => {
    setPickerOpen((prev) => !prev);
  }, []);
  const closePicker = useCallback(() => {
    setPickerOpen(false);
  }, []);

  // Mid-conversation personality switch: when the user picks a new
  // personality while the OpenAI client is live, restart the
  // conversation parts so the new instructions + voice take effect.
  //
  // We skip the restart on the very first render (the store ALWAYS
  // emits the bootstrap value as a first effect run, otherwise we'd
  // restart on every fresh mount). We also skip it when the engine
  // is not live: the next `startConversation()` will already pull
  // the up-to-date personality on its own.
  const previousPersonalityIdRef = useRef<string | null>(null);
  const { restartConversation } = session;
  useEffect(() => {
    const previous = previousPersonalityIdRef.current;
    previousPersonalityIdRef.current = activePersonalityId;
    if (previous === null) return; // first render, nothing to restart
    if (previous === activePersonalityId) return; // no actual change
    if (!live) return; // not in conversation, will be picked up on next start
    void restartConversation().catch((err) => {
      console.warn('[conversation-panel] restartConversation threw:', err);
    });
  }, [activePersonalityId, live, restartConversation]);

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
      spacing={0}
      sx={{
        flex: 1,
        minHeight: 0,
        width: '100%',
        position: 'relative',
      }}
    >
      {/* SUB-HEADER: full-bleed band that hosts the personality
          hero. The band itself is pure structure - full-bleed
          escape (RobotTabView pattern) + border-bottom divider +
          canvas background. The actual identity (avatar, name,
          tagline, tap target) is owned by the PersonalityPill
          component, which spans the band edge-to-edge so the
          entire row is one big tappable affordance. */}
      <Box
        sx={{
          width: '100vw',
          mx: 'calc(50% - 50vw)',
          flexShrink: 0,
          bgcolor: 'background.default',
          borderBottom: t => `1px solid ${t.palette.divider}`,
        }}
      >
        <Box sx={{ maxWidth: 720, mx: 'auto' }}>
          {/* Disable the persona switcher while a conversation is
              live: changing the active persona mid-call would
              force a stop+start of the OpenAI client and audibly
              cut Reachy off mid-sentence. The pill stays mounted
              and keeps showing the current persona, but loses its
              hover / chevron + carries an aria hint explaining
              why it's locked. The user can stop the conversation
              from the orb's stop button (or finish naturally) to
              re-enable the picker. */}
          <PersonalityPill
            open={pickerOpen}
            onToggle={togglePicker}
            disabled={live}
          />
        </Box>
      </Box>

      {/* BODY SLOT: either the orb area or the persona picker grid.
          They share the same flex slot below the sub-header so the
          grid takes EXACTLY the same vertical real estate the orb
          area normally occupies - no overlay, no shifting layout.
          The orb sub-tree is kept mounted (display: none when the
          picker is open) so the engine's audio level monitors keep
          their `orbRef` target across the swap and don't have to
          re-attach when the user closes the picker. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        <Stack
          alignItems="center"
          justifyContent="center"
          spacing={2}
          sx={{
            flex: 1,
            minHeight: 0,
            width: '100%',
            // Asymmetric padding: small `pt` so the orb sits close
            // to the persona sub-header (no awkward gap once the
            // user has selected who's talking), but a generous
            // `pb` so the caption / tool-toast under the orb don't
            // crowd the bottom navigation.
            pt: 1.5,
            pb: 3,
            // Hide the orb area while the picker is open. Mount is
            // preserved so the orb's `<button>` keeps providing
            // `audioLevelsTarget` to the engine - flipping `display`
            // is much cheaper (and safer) than unmounting + re-
            // mounting the whole orb chrome on every picker toggle.
            display: pickerOpen ? 'none' : 'flex',
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
        </Stack>

        {pickerOpen && <PersonalityGrid onClose={closePicker} />}
      </Box>

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
