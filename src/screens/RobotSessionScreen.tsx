/**
 * Robot session screen.
 *
 * Two-tab shell hosted on a single connected robot:
 *
 *   ┌────────────────────────────────────────┐
 *   │ Header (back/power-off + name + chips) │
 *   ├────────────────────────────────────────┤
 *   │                                        │
 *   │  Tab body  (Conversation OR Apps)      │
 *   │                                        │
 *   ├────────────────────────────────────────┤
 *   │ BottomNavigation : [Conv] [Apps]       │
 *   └────────────────────────────────────────┘
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
 * Tabs are independent of the session lifecycle: switching to the
 * Apps tab does NOT release the session; only OPENING an app does.
 * That matches the user's mental model ("I'm just browsing - the
 * robot is still listening to me" vs "I'm in this app now - the
 * robot is talking to it").
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

import {
  extractRobotHardwareId,
  extractRobotId,
  extractRobotName,
  extractRobotTransport,
  type CentralRobotEntry,
} from '../auth/fetchRobotsFromCentral';
import { ConversationPanel } from '../conversation';
import { useRobotSession } from '../session/useRobotSession';
import type { AppEntry } from '../apps/types';
import AppIframeOverlay from './apps/AppIframeOverlay';
import AppsTabView from './apps/AppsTabView';
import ConnectingView from './session/ConnectingView';
import IdentityChipBar from './session/IdentityChipBar';
import LeavingView from './session/LeavingView';
import RobotCameraCard from './session/RobotCameraCard';
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

type Tab = 'conv' | 'apps';

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
      // Just opened an app: release the session so the iframe can
      // dial in. The overlay itself shows a "Releasing…" hint while
      // the promise is in flight; we don't await here so React
      // commits the iframe mount immediately and the overlay's own
      // effects can drive its phase indicator.
      void session.releaseForHandoff();
    } else if (previous !== null && openedApp === null && !leaving) {
      // Just closed an app: bring the session back up so the
      // conversation tab is usable again. We skip this when
      // `leaving` is true because tearDown is already in flight
      // and reacquire would race with it.
      void session.reacquire();
    }
  }, [openedApp, leaving, session]);

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
      }}
    >
      {/* Top toolbar - full bleed, mirror of the BottomNavigation.
       *
       *   ┌─────────────────────────────────────────────────────────┐
       *   │  [⏻]  reachy-mini-foo …  [id:abcd][🛜][@alice]          │
       *   └─────────────────────────────────────────────────────────┘
       *
       * Visual contract:
       *   - `mx: -3` cancels the outer column's `px: 3` so the bar
       *     spans edge-to-edge of the viewport, exactly like the
       *     `BottomNavigation` does at the other end of the screen.
       *   - The bar gets its own `bgcolor: background.paper` and a
       *     1px bottom divider to read as a discrete chrome layer
       *     (the body underneath uses `background.default`).
       *   - `pt = calc(env(safe-area-inset-top) + 8px)` lets the bar
       *     bg paint INTO the iOS notch while keeping the controls
       *     vertically padded. On platforms without an inset we just
       *     get the 8px fallback.
       *   - Internal `px: 3` matches the body's horizontal rhythm so
       *     the power button and chips visually align with the body
       *     content edges.
       *
       * Power-off is ALWAYS the leftmost glyph: on this screen we
       * own a live WebRTC session + woken motors, so the action that
       * takes us back is destructive (gotoSleep + motors disabled +
       * stopSession + disconnect). The robot name takes the
       * remaining space and truncates; the chips stick to the right
       * with `flexShrink: 0` so they're never pushed off-screen.
       */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{
          flexShrink: 0,
          mx: -3,
          px: 3,
          pb: 1,
          pt: 'calc(env(safe-area-inset-top, 0px) + 8px)',
          minHeight: 48,
          bgcolor: 'background.paper',
          borderBottom: t => `1px solid ${t.palette.divider}`,
        }}
      >
        <IconButton
          aria-label="End session"
          onClick={handleLeave}
          color="error"
          disabled={leaving}
          size="small"
          sx={{ ml: -0.5 }}
        >
          <PowerSettingsNewIcon />
        </IconButton>
        <Typography
          sx={{
            flex: 1,
            minWidth: 0,
            fontSize: TYPO.md,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.primary',
          }}
          noWrap
        >
          {robotName}
        </Typography>
        <IdentityChipBar
          hardwareId={robotHardwareId}
          transport={robotTransport}
          username={username}
        />
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
        {/* The conversation panel is mounted whenever the session is
            live. We hide it via CSS when the user switches to the
            Apps tab so the orb chrome doesn't render, but the
            session itself stays up - the WebRTC release happens at
            iframe-open time, not tab-switch time. */}
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
            <ConversationPanel session={session} orbRef={orbRef} />
            {/* Floating camera thumbnail. Only mounted once the
                session is physically live (robot awake, motors on,
                WebRTC video track flowing); before that point the
                placeholder would show "Camera offline" through the
                whole connecting overlay, which is just noise. The
                card is `position: absolute` against the conv-tab
                column so it floats above the orb without disturbing
                its centring math. */}
            {session.hasReachedReady && (
              <RobotCameraCard session={session} />
            )}
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

        {/* Reacquiring overlay stays scoped to the conversation column
            (above the panel, below the header / bottom nav) - the
            user is briefly back on the conv tab and we want them to
            see the chrome they're returning to. */}
        {showReacquiringOverlay && tab === 'conv' && (
          <Overlay>
            <ConnectingView state="connecting" />
          </Overlay>
        )}

        {isError && (
          <SessionErrorView
            message={session.errorMessage}
            onBack={handleLeave}
          />
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
          borderTop: t => `1px solid ${t.palette.divider}`,
          bgcolor: 'background.paper',
        }}
      >
        <BottomNavigationAction
          value="conv"
          label="Conversation"
          icon={<GraphicEqIcon />}
        />
        <BottomNavigationAction value="apps" label="Apps" icon={<AppsIcon />} />
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
          <ConnectingView state={session.engineState} />
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
