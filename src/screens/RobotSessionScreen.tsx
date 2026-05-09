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
import AppsIcon from '@mui/icons-material/Apps';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';

import {
  extractRobotHardwareId,
  extractRobotId,
  extractRobotName,
  extractRobotTransport,
  type CentralRobotEntry,
} from '../auth/fetchRobotsFromCentral';
import { ConversationPanel } from '../conversation';
import AudioControlsBar from '../conversation/control-panel/AudioControlsBar';
// `CameraOverlay` is intentionally NOT imported here at the moment.
// The conversation tab keeps the orb visually clean (no floating
// PIP); the camera surfaces in the dedicated `Robot` tab via
// `<RobotTabView>`, full-width and 4:3, where the user can actually
// frame what Reachy sees. Re-add the import + render it back inside
// the `tab === 'conv'` block if/when we want a small PIP during
// conversations too (the underlying `VideoFeed` already supports
// release/reacquire and concurrent mounts on the same SDK track).
import { useRobotSession } from '../session/useRobotSession';
import type { AppEntry } from '../apps/types';
import AppIframeOverlay from './apps/AppIframeOverlay';
import AppsTabView from './apps/AppsTabView';
import RobotTabView from './robot/RobotTabView';
import ConnectingView from './session/ConnectingView';
import IdentityChipBar from './session/IdentityChipBar';
import LeavingView from './session/LeavingView';
import SessionErrorView from './session/SessionErrorView';
import { FONT_WEIGHT, LAYOUT, TYPO } from '../styles/tokens';

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

  // Daemon version, fetched once per session over the WebRTC data
  // channel after `hasReachedReady` flips. Stays null when the daemon
  // predates the `get_version` Cmd. Mirrors the webrtc_example pattern.
  const [daemonVersion, setDaemonVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!session.hasReachedReady) return;
    if (daemonVersion !== null) return;
    let cancelled = false;
    void (async () => {
      const v = await session.getDaemonVersion();
      if (!cancelled && v) setDaemonVersion(v);
    })();
    return () => {
      cancelled = true;
    };
  }, [session, session.hasReachedReady, daemonVersion]);

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
       * mirrors the discovery-card taxonomy (name + short id on
       * top, transport chip below). Power-off is the rightmost
       * glyph, large enough to be a comfortable thumb target -
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
          transport={robotTransport}
          daemonVersion={daemonVersion}
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
          pt: 2,
          position: 'relative',
        }}
      >
        {/* Conversation tab. Mounted whenever the session is live;
            hidden via CSS (not unmounted) when the user is on
            the Apps tab so the orb's `<button>` keeps providing
            `orbRef` to the engine's audio level monitors.
            Layout:
              ┌──────────────────────────────────┐
              │ ┌─SPEAKER──┐  ┌─MICROPHONE──┐    │  ← top controls
              │ │ [🔊]●─●  │  │ [🎤]●─●     │    │
              │ └──────────┘  └─────────────┘    │
              │                                  │
              │            ORB                   │  ← centre
              │                                  │
              └──────────────────────────────────┘ */}
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
            {/* Top audio controls. Gated on `hasReachedReady` so
                the cards don't pop in during the initial
                connecting overlay (where they'd be unreachable
                anyway). */}
            {session.hasReachedReady && (
              <Box sx={{ flexShrink: 0, mt: 1, mb: 1.5 }}>
                <AudioControlsBar
                  session={session}
                  isLive={session.hasReachedReady}
                />
              </Box>
            )}

            {/* Orb + caption + side buttons + tool toast. Takes
                the remaining vertical space and centres the orb
                inside it. */}
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
        sx={{
          flexShrink: 0,
          mx: -3,
          // Bumped vs the 56px default for a more comfortable
          // thumb target on mobile + a bit more visual presence.
          height: 'auto',
          minHeight: 68,
          // No padding on the parent: spacing lives INSIDE each
          // action below. That way each action covers the full
          // bar height (incl. safe area), so MUI's ripple
          // animation reaches the bar's true top and bottom
          // edges instead of stopping at an inner padding box.
          borderTop: t => `1px solid ${t.palette.divider}`,
          bgcolor: 'background.default',
          '& .MuiBottomNavigationAction-root': {
            minWidth: 0,
            // Inner spacing: small visual padding above the icon,
            // safe-area + small gap below the label so the home
            // indicator on iPhone X+ never crowds the text.
            paddingTop: 1,
            paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + 8px)`,
            gap: 0.5,
          },
          '& .MuiBottomNavigationAction-label': {
            fontSize: TYPO.xs,
            fontWeight: FONT_WEIGHT.medium,
            // Keep the label size stable in the selected state -
            // MUI defaults grow it which makes the bar feel
            // jittery when switching tabs.
            '&.Mui-selected': {
              fontSize: TYPO.xs,
            },
          },
          '& .MuiSvgIcon-root': {
            fontSize: 26,
          },
        }}
      >
        <BottomNavigationAction
          value="conv"
          label="Conversation"
          icon={<GraphicEqIcon />}
        />
        <BottomNavigationAction value="apps" label="Apps" icon={<AppsIcon />} />
        <BottomNavigationAction
          value="robot"
          label="Robot"
          icon={<SmartToyOutlinedIcon />}
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
