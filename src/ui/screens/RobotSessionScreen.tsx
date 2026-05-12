/**
 * Robot session screen.
 *
 * Three-tab shell hosted on a single connected robot:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Header (back/power-off + name + chips)       │
 *   ├──────────────────────────────────────────────┤
 *   │                                              │
 *   │  Tab body  (Conversation | Apps | Robot)     │
 *   │                                              │
 *   ├──────────────────────────────────────────────┤
 *   │ BottomNavigation : [Conv] [Apps] [Robot]     │
 *   └──────────────────────────────────────────────┘
 *
 * Architectural separation (A / B / C / D layers)
 * ───────────────────────────────────────────────
 * `useRobotSession` owns A + B + C: HF auth + WebRTC session +
 * physical posture (wake / sleep). The screen orchestrates the
 * session through that hook and pipes user actions into it.
 *
 * `<ConversationPanel>` is a pure D-layer consumer: it renders the
 * orb chrome from `session.engineState` and forwards user gestures
 * to `session.triggerOrbAction()` / `session.setMicMuted()` etc.
 * It never decides when to connect, when to wake, or when to put
 * the robot to sleep.
 *
 * `<AppIframeOverlay>` is another consumer: it asks the session to
 * release the WebRTC slot (via `session.releaseForHandoff()`) before
 * the iframe dials in, and asks for it back on close (via
 * `session.reacquire()`). The robot stays awake throughout.
 *
 * `<RobotTabView>` is a third consumer: it surfaces the robot's
 * camera feed (via `session.attachVideo`) and the daemon-level
 * audio controls (volume + speaker test via `session.playSound`).
 * It never starts a conversation - the conv pipeline is owned by
 * the Conv tab via `session.startConversation`.
 *
 * Tabs are independent of the session lifecycle: switching tabs
 * does NOT release the WebRTC session; only OPENING an app does.
 * That matches the user's mental model ("I'm just browsing - the
 * robot is still listening to me" vs "I'm in this app now - the
 * robot is talking to it"). The Conv pipeline (D layer) IS stopped
 * on tab-switch because it's the only piece whose silence-while-
 * background is actually surprising / wasteful.
 */
import { useEffect, useRef, useState } from 'react';
import {
  BottomNavigation,
  BottomNavigationAction,
  Box,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';

import AppsIcon from '@/ui/design/icons/AppsIcon';
import MicIcon from '@/ui/design/icons/MicIcon';
import RobotIcon from '@/ui/design/icons/RobotIcon';

import {
  extractRobotHardwareId,
  extractRobotId,
  extractRobotName,
  extractRobotTransport,
  type CentralRobotEntry,
} from '@/features/auth/fetchRobotsFromCentral';
import { ConversationPanel } from '@/ui/panels/conversation/ConversationPanel';
// `CameraOverlay` is intentionally NOT imported here at the moment.
// The conversation tab keeps the orb visually clean (no floating
// PIP); the camera surfaces in the dedicated `Robot` tab via
// `<RobotTabView>`, full-width and 4:3, where the user can actually
// frame what Reachy sees. Re-add the import + render it back inside
// the `tab === 'conv'` block if/when we want a small PIP during
// conversations too (the underlying `VideoFeed` already supports
// release/reacquire and concurrent mounts on the same SDK track).
import { useRobotSession } from '@/features/robot-session/useRobotSession';
import { DaemonStateProvider } from '@/features/daemon-state';
import type { AppEntry } from '@/features/apps/types';
import AppIframeOverlay from '@/ui/panels/apps-list/AppIframeOverlay';
import AppsTabView from '@/ui/panels/apps-list/AppsTabView';
import RobotTabView from '@/ui/panels/robot/RobotTabView';
import ConnectingView from './session/ConnectingView';
import IdentityChipBar from './session/IdentityChipBar';
import LeavingView from './session/LeavingView';
import SessionErrorView from './session/SessionErrorView';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';

export type ConnectionTarget = {
  kind: 'remote';
  robot: CentralRobotEntry;
};

interface RobotSessionScreenProps {
  target: ConnectionTarget;
  token: string;
  username: string | null;
  onBack: () => void;
}

type Tab = 'conv' | 'apps' | 'robot';

export default function RobotSessionScreen({
  target,
  token,
  username,
  onBack,
}: RobotSessionScreenProps) {
  const robotId = extractRobotId(target.robot);
  const robotName = extractRobotName(target.robot) ?? robotId ?? 'Reachy Mini';
  const robotHardwareId = extractRobotHardwareId(target.robot);
  const robotTransport = extractRobotTransport(target.robot);

  // Defensive early-return: a listing without a peer id can't be
  // routed by the SDK. Render a dedicated screen so the user has a
  // clear way out without sitting through a doomed engine bring-up.
  if (!robotId) {
    return <NoPeerIdView robotName={robotName} onBack={onBack} />;
  }

  return (
    <ConnectedSession
      robotId={robotId}
      robotName={robotName}
      robotHardwareId={robotHardwareId}
      robotTransport={robotTransport}
      token={token}
      username={username}
      onBack={onBack}
    />
  );
}

interface ConnectedSessionProps {
  robotId: string;
  robotName: string;
  robotHardwareId: string | null;
  robotTransport: string;
  token: string;
  username: string | null;
  onBack: () => void;
}

/**
 * Inner component split from the export so we can call
 * `useRobotSession()` only AFTER we've validated `robotId` is non-
 * null. React doesn't allow conditional hook calls; nesting the
 * hook into a separate component is the canonical way to keep the
 * "no peer id" early-return path hook-free.
 */
function ConnectedSession({
  robotId,
  robotName,
  robotHardwareId,
  robotTransport,
  token,
  username,
  onBack,
}: ConnectedSessionProps) {
  const orbRef = useRef<HTMLButtonElement | null>(null);
  const session = useRobotSession({
    robotId,
    token,
    audioLevelsTargetRef: orbRef,
  });

  const [tab, setTab] = useState<Tab>('conv');
  /**
   * App selected from the catalog; non-null while the iframe overlay
   * is being prepared (`releasing`), shown (`ready`), or closing
   * (`reacquiring`). The handoff lifecycle is managed via the
   * effects below so the iframe's mount lines up with the WebRTC
   * release.
   */
  const [openedApp, setOpenedApp] = useState<AppEntry | null>(null);

  // Daemon version is fetched (with retry-on-null) by the
  // `<DaemonStateProvider>` further down and read by the camera
  // debug overlay (`<CameraDebugOverlay>` inside `<RobotTabView>`)
  // via `useDaemonState()`. Centralising it there means the same
  // value is shared across every consumer (overlay, audio cards,
  // future settings panels, etc.) without any component having to
  // fetch it locally.

  // Power-off / back: drives `session.tearDown()` (gotoSleep + motors
  // disabled + stopSession + disconnect) before navigating away. The
  // screen renders the leaving view in the meantime.
  const [leaving, setLeaving] = useState(false);
  const leavingTriggeredRef = useRef(false);
  useEffect(() => {
    if (!leaving) return;
    let cancelled = false;
    void (async () => {
      await session.tearDown();
        if (cancelled) return;
      onBack();
    })();
    return () => {
      cancelled = true;
    };
  }, [leaving, onBack, session]);

  const handleLeave = (): void => {
    if (leavingTriggeredRef.current) return;
    leavingTriggeredRef.current = true;
    setLeaving(true);
  };

  // Handoff lifecycle for the apps iframe.
  //
  //   user taps app card  →  setOpenedApp(app)
  //                         ↓
  //                    session.releaseForHandoff()
  //                         ↓
  //                    iframe overlay mounts
  //                         ↓
  //                    user closes iframe  →  setOpenedApp(null)
  //                         ↓
  //                    session.reacquire()
  //                         ↓
  //                    conversation tab can resume normally
  //
  // The release+reacquire calls go through the engine's lifecycle
  // queue, so a fast user (open / close before the previous step
  // resolves) gets queued operations instead of races.
  const previousOpenedAppRef = useRef<AppEntry | null>(null);
  useEffect(() => {
    const previous = previousOpenedAppRef.current;
    previousOpenedAppRef.current = openedApp;
    if (previous === null && openedApp !== null) {
      console.log(
        `[shell-webrtc] iframe-open: releasing session for app ${openedApp.id}`,
      );
      // Just opened an app: release the session so the iframe can
      // dial in. The overlay itself shows a "Releasing…" hint while
      // the promise is in flight; we don't await here so React
      // commits the iframe mount immediately and the overlay's own
      // effects can drive its phase indicator.
      void session.releaseForHandoff();
    } else if (previous !== null && openedApp === null && !leaving) {
      console.log(
        `[shell-webrtc] iframe-close: reacquiring session after app ${previous.id}`,
      );
      // Just closed an app: bring the session back up so the
      // conversation tab is usable again. We skip this when
      // `leaving` is true because tearDown is already in flight
      // and reacquire would race with it.
      void session.reacquire();
    }
  }, [openedApp, leaving, session]);

  // Tab-switch lifecycle for the conversation parts.
  //
  // Leaving the conversation tab stops the OpenAI Realtime pipeline,
  // motion controllers and audio analysers. The robot stays awake
  // (gravity-comp on the head/antennas, motors enabled, WebRTC up,
  // SSE alive) so re-entering the tab is instant - the user just
  // sees the orb in `ready`, taps once, and they're back in a fresh
  // conversation.
  //
  // Why stop on tab switch (not on iframe-open): going to the apps
  // surface signals "I'm browsing, not talking". Having the AI
  // listen / speak in the background while the user picks an app
  // wastes API tokens and is confusing audio-wise (the robot still
  // narrates while the apps tab is shown). Stopping here is the
  // minimal-surprise default.
  //
  // `stopConversation` is idempotent (no-op if no conversation is
  // running), so this effect is safe to fire on every non-`conv`
  // render including initial mounts and rapid tab oscillations.
  const { stopConversation } = session;
  useEffect(() => {
    if (tab === 'conv') return;
    void stopConversation();
  }, [tab, stopConversation]);

  const isError = session.phase === 'error' && !leaving;
  // Connecting overlay: only fires for the INITIAL bring-up. After
  // `hasReachedReady` flips, subsequent transient states (a
  // re-acquire after handoff, the conversation re-starting) keep
  // the orb on screen with its own internal spinner instead of the
  // full-screen overlay.
  const showConnectingOverlay =
    !leaving &&
    !isError &&
    !session.hasReachedReady &&
    session.phase === 'bringing-up';

  // Reacquiring overlay: fires every time we come back from an
  // iframe handoff. Short-lived (typically <2 s) and the panel
  // stays mounted underneath so the orb resumes smoothly.
  const showReacquiringOverlay =
    !leaving && !isError && session.phase === 'reacquiring';

  return (
    /* `DaemonStateProvider` is the single source of truth for
       what the daemon currently reports (volumes, version, future
       motor mode, etc.). It mounts here so every tab body and the
       top toolbar share the same fetched values - no double
       round-trips, no race-on-null artefacts where one tab sees
       a stale `null` while another already fetched. The provider
       gates its own fetch lifecycle on `enabled`; we wire it to
       `session.hasReachedReady` so we only round-trip once the
       engine is past bring-up. */
    <DaemonStateProvider session={session} enabled={session.hasReachedReady}>
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        px: 3,
        pb: 0,
        // No explicit bg: we inherit `background.default` (grey)
        // from the App root and let the cards inside (audio
        // controls, app cards) be the only WHITE surfaces. Same
        // pattern as `ScanScreen` and the rest of the app:
        // single grey canvas + white card islands, top + bottom
        // bars blend with the canvas (only divider lines
        // separate them).
      }}
    >
      {/* Top toolbar - full bleed, mirror of the BottomNavigation.
       *
       *   ┌─────────────────────────────────────────────────────────┐
       *   │  reachy-mini-foo  #abc12                          [⏻]  │
       *   │  [Wi-Fi]                                                 │
       *   └─────────────────────────────────────────────────────────┘
       *
       * Visual contract:
       *   - `mx: -3` cancels the outer column's `px: 3` so the bar
       *     spans edge-to-edge of the viewport, exactly like the
       *     `BottomNavigation` does at the other end of the screen.
       *   - The bar uses `background.default` (grey) - the same
       *     tone as the body. They blend visually; only the
       *     1 px bottom divider demarcates the bar from the
       *     content. Cards inside the body are
       *     `background.paper` (white) and pop as the only
       *     "interesting" surfaces. Same convention as
       *     `ScanScreen` and the rest of the app.
       *   - `pt = calc(env(safe-area-inset-top) + 12px)` lets the
       *     bar bg paint INTO the iOS notch while keeping the
       *     controls vertically padded. On platforms without an
       *     inset we just get the 12px fallback.
       *   - Internal `px: 3` matches the body's horizontal rhythm so
       *     the identity column and power button visually align
       *     with the body content edges.
       *
       * Identity (`IdentityChipBar`) takes the left flex column and
       * carries the everyday-grade identity: robot name + physical
       * transport chip (Wi-Fi / USB) + short hardware id. The
       * debug-grade signals (daemon version, live WebRTC kind +
       * IP + bitrate) relocated to a `<CameraDebugOverlay>` inside
       * the Robot tab's video frame - they were crowding the
       * topbar on small phones and competing with the power-off
       * button for thumb space. Power-off is the rightmost glyph,
       * large enough to be a comfortable thumb target -
       * tapping it is destructive (gotoSleep + motors disabled +
       * stopSession + disconnect) so we want it deliberate but
       * easy to reach. We dropped the `@username` chip: the user
       * is by definition signed in here, the redundant pill was
       * just noise.
       */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={{
          flexShrink: 0,
          mx: -3,
          px: 3,
          pb: 2,
          pt: 'calc(env(safe-area-inset-top, 0px) + 14px)',
          minHeight: 76,
          bgcolor: 'background.default',
          borderBottom: t => `1px solid ${t.palette.divider}`,
        }}
      >
        <IdentityChipBar
          robotName={robotName}
          hardwareId={robotHardwareId}
          fallbackId={robotId}
          transport={robotTransport}
        />
        <IconButton
          aria-label="End session"
          onClick={handleLeave}
          color="primary"
          disabled={leaving}
          sx={{
            mr: -0.5,
            flexShrink: 0,
          }}
        >
          <PowerSettingsNewIcon sx={{ fontSize: 24 }} />
        </IconButton>
      </Stack>

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: LAYOUT.contentMaxWidth,
          mx: 'auto',
          // No `pt` here on purpose: each tab's body owns its own
          // top spacing. The conv tab's persona sub-header needs
          // to sit FLUSH against the top toolbar's bottom divider
          // so the two bands read as one continuous chrome strip;
          // any `pt` here would push it down with a stray gap.
          // The apps + robot tabs already apply their own `pt: 1`
          // inside their content stacks (see AppsTabView /
          // RobotTabView), so the visual rhythm stays the same
          // for them.
          position: 'relative',
        }}
      >
        {/* Conversation tab. Mounted whenever the session is live;
            hidden via CSS (not unmounted) when the user is on
            the Apps tab so the orb's `<button>` keeps providing
            `orbRef` to the engine's audio level monitors.
            Layout:
              ┌──────────────────────────────────┐
              │                                  │
              │                                  │
              │            ORB                   │  ← centre, full
              │                                  │     vertical space
              │                                  │
              └──────────────────────────────────┘

            The Speaker / Microphone cards used to live above the
            orb here; they were redundant with the dedicated
            Robot tab (`<RobotTabView>`) which exposes the same
            cards alongside the camera + future logs. Keeping the
            conv tab orb-only matches the desktop minimal-conversation
            shell and lets the orb breathe full-height on small
            phones. */}
        {!leaving && !isError && (
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: tab === 'conv' ? 'flex' : 'none',
              flexDirection: 'column',
              position: 'relative',
            }}
          >
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <ConversationPanel session={session} orbRef={orbRef} />
            </Box>
          </Box>
        )}

        {tab === 'apps' && !leaving && (
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <AppsTabView onOpen={setOpenedApp} />
          </Box>
        )}

        {tab === 'robot' && !leaving && !isError && (
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <RobotTabView session={session} isLive={session.hasReachedReady} />
          </Box>
        )}

        {/* Reacquiring overlay stays scoped to the conversation column
            (above the panel, below the header / bottom nav) - the
            user is briefly back on the conv tab and we want them to
            see the chrome they're returning to. */}
        {showReacquiringOverlay && tab === 'conv' && (
          <Overlay>
            <ConnectingView state="connecting" />
          </Overlay>
        )}
      </Box>

      <BottomNavigation
        value={tab}
        showLabels
        onChange={(_, value: Tab) => {
          if (leaving) return;
          setTab(value);
        }}
        sx={(theme) => ({
          flexShrink: 0,
          mx: -3,
          // BottomNavigation sizing on iPhone X+ : the bar must be
          // tall enough to host BOTH the comfortable 68 px tap row
          // AND the iOS home-indicator safe-area below it, AND each
          // action button's `paper` selected fill must reach the
          // physical bottom edge of the screen (Material convention:
          // the active tab visually anchors the column down to the
          // device edge, no orphan strip below).
          //
          // The previous attempt put the safe-area inset on the
          // parent's `padding-bottom`. That left the actions a clean
          // 68 px tall - good for centering - but the parent
          // padding's grey "shoe" appeared underneath the active
          // tab's paper fill, so the selected tab visibly stopped
          // ~34 px above the bottom edge on iPhone X+. The user's
          // expectation is the opposite: paper fill flush to the
          // bottom edge.
          //
          // Fix: stretch the actions to the FULL bar height (68 +
          // safe-area). The action is a flex child with `align-items:
          // stretch` (MUI default) so it naturally fills the bar's
          // cross-axis, including the home-indicator zone. With
          // symmetric inner padding the icon + label cluster centers
          // at the bar's true vertical middle - which on iPhone X+
          // sits a touch above the home-indicator pill, leaving ~30
          // px of breathing room below the label so the swipe-up
          // gesture stays unambiguous.
          //
          // On platforms with no safe area (macOS Tauri, Android,
          // desktop) `env()` resolves to 0 and the bar collapses
          // back to a flush 68 px - same rendering as before.
          height: 'auto',
          minHeight: 'calc(68px + env(safe-area-inset-bottom, 0px))',
          borderTop: `1px solid ${theme.palette.divider}`,
          bgcolor: 'background.default',
          '& .MuiBottomNavigationAction-root': {
            minWidth: 0,
            // Symmetric inner padding so the icon + label cluster is
            // truly centered in the action's full visual height
            // (68 + safe-area). The cluster ends up vertically
            // centered between the top divider and the device's
            // bottom edge, with the safe-area zone acting as
            // breathing room below the label rather than as dead
            // space outside the action.
            paddingTop: 0.75,
            paddingBottom: 0.75,
            gap: 0.5,
            backgroundColor: 'transparent',
            transition: theme.transitions.create(
              ['background-color', 'box-shadow'],
              {
                duration: 180,
                easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
              },
            ),
            // Selected state. We keep MUI's default colour rules
            // for the icon (`text.secondary` inactive,
            // `primary.main` active) and swap the bg to
            // `background.paper` so the active tab pops against
            // the bar's `background.default` grey backdrop. Using
            // a palette token (rather than a hard `#fff`) means
            // the contrast holds in both modes: in light mode the
            // active tab reads as a paper card on a grey bar; in
            // dark mode it's a slightly lighter dark surface on a
            // darker bar - same visual hierarchy, both palettes.
            // No outline: the paper fill + the primary-tinted
            // icon are enough to identify the active tab, and an
            // outline added visual noise that competed with the
            // divider lines between siblings.
            '&.Mui-selected': {
              backgroundColor: theme.palette.background.paper,
            },
          },
          // Light vertical divider between adjacent actions.
          // Painted via `inset box-shadow` rather than `borderRight`
          // so it doesn't add 1 px to the action's flex basis (each
          // action stays exactly 1/N of the bar's width). Applied
          // to every action except the last so the right edge of
          // the bar stays clean.
          '& .MuiBottomNavigationAction-root:not(:last-of-type)': {
            boxShadow: `inset -1px 0 0 0 ${theme.palette.divider}`,
          },
          // Label colour. We deliberately keep the label in
          // `text.secondary` (MUI's default) - the icon glyph
          // carries the brand colour, the label stays neutral
          // and supportive so the bar reads as a hierarchy
          // (icon = identity, label = wayfinding) rather than
          // a wall of primary text. The selected-state cue is
          // the soft fill on the action button + the slight
          // weight bump below.
          '& .MuiBottomNavigationAction-label': {
            fontSize: TYPO.xs,
            fontWeight: FONT_WEIGHT.medium,
            color: `${theme.palette.text.secondary} !important`,
          },
          // Selected = same colour, heavier weight. We pin the
          // size so the bar doesn't twitch (MUI defaults bump
          // the font size on selection).
          '& .MuiBottomNavigationAction-label.Mui-selected': {
            fontSize: TYPO.xs,
            fontWeight: FONT_WEIGHT.semibold,
            color: `${theme.palette.text.secondary} !important`,
          },
          // Sizing applies to both MUI icons (`MuiSvgIcon-root`)
          // and native `<svg>` elements - the latter is what
          // `vite-plugin-svgr` produces for our custom SVG icons
          // (e.g. `RobotIcon`). Using `font-size` over a hard
          // `width/height` keeps both kinds responsive: the SVG
          // components are configured (`svgrOptions.icon: true`
          // in vite.config.ts) to render at `1em × 1em`, so the
          // parent's font-size drives their rendered size.
          '& .MuiSvgIcon-root, & .MuiBottomNavigationAction-root > svg': {
            fontSize: 26,
          },
        })}
      >
        {/* Conversation = "tap to talk to Reachy". We use the
            shared `MicIcon` (a stroke-only outlined mic, the
            same SVG that lives at the centre of the
            `<ConversationOrb>`) so a glance at the bottom nav
            tells the user "this tab is the mic at the centre of
            the orb you'll see inside". */}
        <BottomNavigationAction
          value="conv"
          label="Conversation"
          icon={<MicIcon />}
        />
        {/* Bespoke `AppsIcon` (4 hollow rounded squares in a 2×2
            grid) so the glyph matches the visual rhythm of
            `MicIcon` and `RobotIcon` - same `1.8 px` stroke
            weight, same outline-only treatment, same 24×24
            viewBox. */}
        <BottomNavigationAction
          value="apps"
          label="Apps"
          icon={<AppsIcon />}
        />
        {/* Robot tab uses the bespoke `RobotIcon` (lifted from
            `assets/robot--icon.svg`). Same Reachy silhouette the
            user sees on every robot avatar across the app
            (discovery cards, identity bar). */}
        <BottomNavigationAction
          value="robot"
          label="Robot"
          icon={<RobotIcon />}
        />
      </BottomNavigation>

      {openedApp && (
        <AppIframeOverlay
          app={openedApp}
          hfToken={token}
          hfUsername={username}
          robotPeerId={robotId}
          robotName={robotName}
          sessionPhase={session.phase}
          onClose={() => setOpenedApp(null)}
        />
      )}

      {/* Full-screen connecting transition: covers EVERYTHING (header,
          identity chips, body, bottom nav) so the user sees only the
          spinning indicator until the robot is physically online. The
          conversation panel keeps rendering underneath so its
          `orbRef` is populated by the time the engine's audio level
          monitors spin up. */}
      {showConnectingOverlay && (
        <FullScreenTransition>
          <ConnectingView
            state={session.engineState}
            connectionAttempt={session.connectionAttempt}
          />
        </FullScreenTransition>
      )}
      {/* Full-screen leaving transition: covers EVERYTHING while the
          engine is mid-teardown (gotoSleep + motors disabled +
          stopSession + disconnect). */}
      {leaving && (
        <FullScreenTransition>
          <LeavingView />
        </FullScreenTransition>
      )}
      {/* Full-screen error transition: when the engine reports a
          fatal state (connection lost, etc.), the error card must
          cover EVERYTHING - top bar, body, bottom nav. Rendering
          it inside the body column would scope it to whatever tab
          the user happened to be on when the engine died (e.g.
          showing the "connection lost" card *inside the apps
          list*, which reads as a contextual error rather than the
          critical session-level event it is). The overlay sits
          above all other surfaces and lets the user back out via
          its primary CTA. */}
      {isError && (
        <FullScreenTransition>
          <SessionErrorView
            message={session.errorMessage}
            onBack={handleLeave}
          />
        </FullScreenTransition>
      )}
    </Stack>
    </DaemonStateProvider>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={theme => ({
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        bgcolor: theme.palette.background.default,
        zIndex: 1,
      })}
    >
      {children}
    </Box>
  );
}

/**
 * Viewport-spanning transition cover. Uses the same layering as
 * `<AppIframeOverlay>` (`position: fixed`, `zIndex: 1300`, matching
 * MUI's modal layer) so it sits above the bottom navigation, the
 * header chrome, AND any open iframe overlay (the latter shouldn't
 * happen with our current state machine but the layering is safe).
 */
function FullScreenTransition({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={(theme) => ({
        position: 'fixed',
        inset: 0,
        zIndex: 1300,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: theme.palette.background.default,
      })}
    >
      {children}
    </Box>
  );
}

function NoPeerIdView({
  robotName,
  onBack,
}: {
  robotName: string;
  onBack: () => void;
}) {
  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        px: 3,
        pt: LAYOUT.safeAreaTop,
        pb: 4,
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ mb: 2, minHeight: 40 }}
      >
        <IconButton aria-label="Back" onClick={onBack} edge="start">
            <ArrowBackIcon />
          </IconButton>
        <Typography
          sx={{
            flex: 1,
            fontSize: TYPO.lg,
            fontWeight: FONT_WEIGHT.semibold,
            textAlign: 'center',
            mr: 5,
          }}
        >
          {robotName}
        </Typography>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <SessionErrorView
          headline="Robot has no peer id"
          message={
            "The robot listing on Hugging Face doesn't carry a routable identifier. " +
            'The robot may be offline or registering - try again in a moment.'
          }
          onBack={onBack}
        />
      </Box>
    </Stack>
  );
}
