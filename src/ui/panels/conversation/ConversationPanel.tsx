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
import { Box, Divider, Stack } from '@mui/material';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { ConversationOrb, type OrbState } from './orb/ConversationOrb';
import { ConversationCaption } from './orb/ConversationCaption';
import { MuteSideButton, StopSideButton } from './orb/ConversationSideButtons';
import { ConversationToolToast } from './orb/ConversationToolToast';
import type { AppState } from '@/features/conversation/engine/conversation-engine';
import { useDaemonState } from '@/features/daemon-state';
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { useActivePersonality } from '@/features/personalities';
import { useActiveLanguageId } from '@/features/conversation-language';
import AudioControlCard from '@/ui/widgets/audio-controls/AudioControlCard';
import { LanguageFlagPicker } from '@/ui/widgets/language-picker';
import { PersonalityGrid, PersonalityPill } from '@/ui/widgets/personality-pill';
import { LAYOUT } from '@/ui/design/tokens';

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

export function ConversationPanel({ session, orbRef }: ConversationPanelProps) {
  const orbState = mapAppStateToOrb(session.engineState);
  const live =
    session.engineState === 'listening' ||
    session.engineState === 'user-speaking' ||
    session.engineState === 'processing' ||
    session.engineState === 'ai-speaking';

  // Daemon-side audio state (volumes + mute toggles). Read here so
  // the bottom audio strip stays in lockstep with the daemon
  // without round-tripping props down through the orb subtree.
  // While the engine hasn't reached `ready` for the first time the
  // values are `null`; the sliders fall back to 50 (the daemon's
  // own default) and the strip is disabled so the user can't drag
  // against an unreachable daemon.
  const daemon = useDaemonState();
  const audioReady = session.hasReachedReady;

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
    setPickerOpen(prev => !prev);
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
    void restartConversation().catch(err => {
      console.warn('[conversation-panel] restartConversation threw:', err);
    });
  }, [activePersonalityId, live, restartConversation]);

  // Mid-conversation language switch. Same shape as the personality
  // restart effect above: `composeInstructions()` (in the engine)
  // reads the active language lazily from the store, so the only
  // thing this panel needs to do on a language change is drop the
  // live OpenAI client and bring it back. The next handshake then
  // picks up the new prompt fragment automatically.
  //
  // Skip rules:
  //   - first render: the store emits its bootstrap value before any
  //     real user action, restarting on it would tear down a freshly
  //     established session for nothing.
  //   - no actual change: the store fires for every mutation, but
  //     `setActiveLanguageId` is itself a no-op when the id matches,
  //     so this guard is purely a belt-and-braces.
  //   - engine not live: a future `startConversation()` will pull
  //     the fresh language on its own, no need to restart from
  //     `released` / `idle`.
  const activeLanguageId = useActiveLanguageId();
  const previousLanguageIdRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousLanguageIdRef.current;
    previousLanguageIdRef.current = activeLanguageId;
    if (previous === null) return;
    if (previous === activeLanguageId) return;
    if (!live) return;
    void restartConversation().catch(err => {
      console.warn('[conversation-panel] restartConversation (language) threw:', err);
    });
  }, [activeLanguageId, live, restartConversation]);

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
    void session.stopConversation().catch(err => {
      console.warn('[conversation-panel] stopConversation threw:', err);
    });
  };

  const handleOrbClick = (): void => {
    void session.triggerOrbAction().catch(err => {
      console.warn('[conversation-panel] triggerOrbAction threw:', err);
    });
  };

  return (
    <Stack
      spacing={0}
      sx={{
        alignItems: 'center',
        justifyContent: 'center',
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
          <PersonalityPill open={pickerOpen} onToggle={togglePicker} disabled={live} />
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
        {/* Three-row grid (`1fr auto 1fr`) so the orb itself is
            vertically centered in the body slot, not the
            "orb + caption + toast" block as a whole. The two
            `1fr` spacer rows above and below the orb take equal
            shares of the remaining space, which mathematically
            anchors the orb's centre on the slot's centre line.
            The caption + toast sit at the TOP of the third row
            (`alignSelf: 'start'`), so they hang just under the
            orb without pulling its centre upwards.
            Prior layout was a single column flex with
            `justifyContent: 'center'` and `spacing={2}`, which
            centred the whole stack (orb + caption + toast) and
            therefore placed the orb visibly above the geometric
            centre of the slot - the bug the user reported. */}
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            width: '100%',
            pt: 1.5,
            pb: 3,
            display: pickerOpen ? 'none' : 'grid',
            gridTemplateRows: '1fr auto 1fr',
            justifyItems: 'center',
          }}
        >
          {/* Top spacer: balances the third row so the orb stays
              centred regardless of caption / toast content. */}
          <Box />
          <Stack
            direction="row"
            spacing={1.25}
            sx={{
              alignItems: 'center',
              justifyContent: 'center',
            }}
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
          {/* Caption + toast anchored at the top of the bottom
              spacer row, just under the orb. `alignSelf: 'start'`
              keeps them flush to the orb's bottom edge (plus the
              `mt` breathing room) while the spacer row absorbs
              the leftover vertical space, so a longer caption or
              a toast appearing doesn't push the orb around. */}
          <Stack
            spacing={1}
            sx={{
              alignItems: 'center',
              alignSelf: 'start',
              mt: 2,
            }}
          >
            <ConversationCaption state={orbState} message={session.errorMessage} />
            <ConversationToolToast label={session.toolToastLabel} />
          </Stack>
        </Box>

        {/* Bottom audio strip: speaker + microphone sliders. Lives
            inside the body box as a sibling of the orb's centered
            stack, so the column flow anchors it to the bottom of
            the conv area while the orb stays centered in the
            remaining space above. Used to live in the Robot tab
            but the user is more likely to want to nudge their
            volume while looking at the orb (mid-conversation)
            than from the diagnostics tab.

            Hidden while the personality picker is open: the user
            is browsing personas, sliders below the grid would
            split attention. Re-rendering on toggle is cheap (no
            heavy state - the sliders just read `daemon`). */}
        {!pickerOpen && (
          <Box
            sx={{
              flexShrink: 0,
              // Full-bleed escape, mirrors the persona sub-header
              // at the top of the panel. The strip is rendered
              // inside `RobotSessionScreen`, which wraps the whole
              // tab body in a `Stack` with `px: 3` (24 px on each
              // side) for the orb's breathing room. Without this
              // escape, the strip would inherit those 24 px gaps
              // on both sides and the borderTop hairline would
              // stop short of the screen edges - which is exactly
              // what the user has been seeing.
              //
              // `width: '100vw'` + `mx: 'calc(50% - 50vw)'` is the
              // canonical way to break out of an arbitrary parent
              // padding chain in a centred layout: the box sizes
              // itself to the viewport and recenters via a
              // negative margin computed from its own offset.
              width: '100vw',
              mx: 'calc(50% - 50vw)',
              // Top border detaches the strip from the orb / caption
              // area above. Using the theme's divider keeps the line
              // consistent with the persona sub-header divider at the
              // top of the panel - the conv area now sits between two
              // matching hairlines, which reads as a properly framed
              // body slot rather than a free-floating orb.
              borderTop: t => `1px solid ${t.palette.divider}`,
            }}
          >
            {/* Bottom utility strip. Three tools in a single row,
                each cell visually separated by a thin vertical
                "tick" divider that spans the strip edge-to-edge:
                  │[🇫🇷]│[🔊 ──●──]│[🎤 ──●──]│
                The dividers reinforce that each cell is its own
                control - language preference is independent from
                speaker volume which is independent from mic
                volume - and give the strip a "toolbar" rhythm in
                line with the borderTop hairline above. The audio
                cards keep a 50/50 split of the remaining width;
                the picker takes its intrinsic width (32×32
                anchor) and never compresses on small screens.

                Stack `spacing={0}` (cells touch the dividers
                directly) + per-cell `px: STRIP_CELL_PX` give us
                the breathing room around the divider WITHOUT
                inserting gaps between cells and dividers. That
                way the dividers reach the full strip height
                (thanks to `alignItems="stretch"`) and the strip
                content reaches the full strip width.

                Inner `maxWidth: LAYOUT.contentMaxWidth` keeps the
                cells from sprawling on large viewports, mirroring
                how the persona sub-header caps its inner box too
                - the hairline spans the screen, the controls stay
                in the central column. */}
            <Box sx={{ maxWidth: LAYOUT.contentMaxWidth, mx: 'auto' }}>
              <Stack
                direction="row"
                spacing={0}
                sx={{
                  alignItems: 'stretch',
                  width: '100%',
                }}
              >
                <Box
                  sx={{
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    px: STRIP_CELL_PX,
                    py: STRIP_CELL_PY,
                  }}
                >
                  <LanguageFlagPicker disabled={session.engineState === 'error'} />
                </Box>
                <StripDivider />
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    px: STRIP_CELL_PX,
                    py: STRIP_CELL_PY,
                  }}
                >
                  <AudioControlCard
                    kind="speaker"
                    value={daemon.speakerVolume ?? 50}
                    onChange={daemon.setSpeakerVolume}
                    onToggleMute={daemon.toggleSpeakerMute}
                    disabled={!audioReady}
                  />
                </Box>
                <StripDivider />
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    px: STRIP_CELL_PX,
                    py: STRIP_CELL_PY,
                  }}
                >
                  <AudioControlCard
                    kind="microphone"
                    value={daemon.microphoneVolume ?? 50}
                    onChange={daemon.setMicrophoneVolume}
                    onToggleMute={daemon.toggleMicrophoneMute}
                    disabled={!audioReady}
                  />
                </Box>
              </Stack>
            </Box>
          </Box>
        )}

        {pickerOpen && <PersonalityGrid onClose={closePicker} />}
      </Box>
      {/* The engine-host inert div used to live here for legacy
          API compat with `mountConversation(root, opts)`. The hook
          now creates its own detached root so the panel doesn't
          need to expose any DOM to the engine. */}
      <Box aria-hidden="true" sx={{ display: 'none' }} />
    </Stack>
  );
}

/**
 * Vertical padding applied to each cell of the bottom utility
 * strip (in MUI spacing units - 1.75 = 14px).
 *
 * Lives on the cells (not on the outer strip Box) so the inter-
 * cell vertical dividers can stretch the full strip height. The
 * cells then center their own content vertically, so the visual
 * outcome matches the previous "centered row" layout while the
 * dividers gain top-to-bottom reach.
 *
 * Kept as a module-level constant so both audio cells and the
 * language cell stay in lockstep - a future tweak to row breath
 * only needs to change one number.
 */
const STRIP_CELL_PY = 1.75;

/**
 * Horizontal padding applied to each cell of the bottom utility
 * strip (in MUI spacing units - 1.5 = 12px).
 *
 * Same rationale as `STRIP_CELL_PY`: by moving the L/R breathing
 * room from the outer strip box onto each cell, the vertical
 * dividers can sit flush against the cells (Stack `spacing={0}`)
 * and the strip's content reaches all the way to the strip's
 * own left + right edges. Tuned slightly tighter than the
 * vertical padding so the strip reads as a horizontal toolbar
 * rather than a chunky button row.
 */
const STRIP_CELL_PX = 1.5;

/**
 * Vertical "tick" divider used between the three cells of the
 * bottom utility strip (language picker, speaker, microphone).
 *
 * Local component because we render it twice and want both
 * occurrences to stay byte-identical: future tweaks (height,
 * colour, opacity) propagate in one place instead of drifting
 * between the two call sites. Kept private to the file - this is
 * panel-internal styling chrome, not something to expose.
 *
 * Visual posture: edge-to-edge of the strip (no vertical margin)
 * so the line reads as a clean toolbar separator rather than a
 * floating tick. Combined with the `alignItems="stretch"` on the
 * outer row and the per-cell `py: STRIP_CELL_PY`, this divider
 * reaches from the strip's `borderTop` hairline all the way to
 * its bottom edge, framing each cell as its own column.
 */
function StripDivider() {
  return <Divider orientation="vertical" flexItem sx={{ borderColor: 'divider' }} />;
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
