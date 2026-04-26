/**
 * Unified post-discovery screen for both LAN (BLE) and remote (HF
 * central) connections.
 *
 * Why one screen for both transports
 * ──────────────────────────────────
 * Before this file existed, BLE pairings traversed a 3-step probe
 * screen → a fully-chromed "Connected" view, and remote pickups
 * jumped straight into a minimal converse view with no progress
 * feedback and no motor wake/sleep. Same physical robot, two
 * dramatically different UX paths. This screen unifies them so:
 *
 *   - Both flows share the same 4-step stepper, with mode-specific
 *     labels (`Bluetooth → Network → Daemon → Conversation` for LAN,
 *     `Hugging Face → WebRTC → Daemon → Conversation` for remote).
 *   - Both flows wake the robot on arrival and put it back to
 *     sleep on departure, going through the transport-agnostic
 *     `robotMotion` store - so the wake_up animation plays whether
 *     the user is on the same Wi-Fi or 800 km away.
 *   - Both flows share the same post-connect chrome (top bar with
 *     menu, daemon status pill, optional Apps tab).
 *
 * Phase machine
 * ─────────────
 *   'handshake' → sequential pre-engine probes (LAN) or instant
 *                 confirmation (remote). On failure, retry/wifi-setup
 *                 affordances appear.
 *   'engine'    → ConversePanel mounted (visible: false). We observe
 *                 the engine's AppState transitions and wait for it
 *                 to leave the transient `connecting/auto-selecting/
 *                 starting` set.
 *   'live'      → Full chrome shown, ConversePanel visible. Wake-up
 *                 sequence kicked off in the background (the user
 *                 doesn't wait on it visually - the conversation is
 *                 already usable).
 *   'leaving'   → Back tapped. We unmount ConversePanel (engine
 *                 teardown lands `endSession` on central) and queue
 *                 `setDesiredState('sleeping')`. Both flushes are
 *                 awaited with a hard timeout before yielding to the
 *                 parent's `onBack`.
 *
 * Wake-up timing (background)
 * ───────────────────────────
 * The wake_up animation takes ~2 s and isn't gating: the user
 * doesn't need motors enabled to start a conversation. We fire
 * `setDesiredState('awake')` the moment we enter 'live' so the
 * motors come online while the user is reading the first AI
 * response. By the time they actually want the robot to move, it
 * already has torque.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Avatar,
  Box,
  BottomNavigation,
  BottomNavigationAction,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Typography,
  keyframes,
  useTheme,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AppsIcon from '@mui/icons-material/Apps';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import LoginIcon from '@mui/icons-material/Login';
import LogoutIcon from '@mui/icons-material/Logout';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import ReplayIcon from '@mui/icons-material/Replay';
import WifiIcon from '@mui/icons-material/Wifi';

import {
  extractRobotId,
  extractRobotName,
  type CentralRobotEntry,
} from '../auth/fetchRobotsFromCentral';
import { useHfAuth } from '../auth/useHfAuth';
import {
  useBleSession,
  type NetworkStatus,
  type ReachyBleDevice,
} from '../ble/useBleSession';
import DaemonStatusPill from '../components/DaemonStatusPill';
import ForgetWifiDialog from '../components/ForgetWifiDialog';
import HeroIllustration from '../components/HeroIllustration';
import HfLoginOverlay from '../components/HfLoginOverlay';
import OutdatedDaemonBanner from '../components/OutdatedDaemonBanner';
import StepperHeader from '../components/StepperHeader';
import { AppsPanel } from '../conversation/AppsPanel';
import {
  ConversePanel,
  flushEngineLifecycle,
} from '../conversation/ConversePanel';
import type { AppState } from '../conversation/conversation-engine';
import { daemonFetch } from '../daemon/daemonFetch';
import {
  probeDaemonVersion,
  type DaemonVersionInfo,
} from '../daemon/daemonProbeVersion';
import {
  flushPending as flushMotionPending,
  setDesiredState,
} from '../daemon/robotMotion';
import { useDaemonStatus } from '../daemon/useDaemonStatus';
import { createLogger, newTraceId, setTraceId } from '../logger';
import { createRobotClient } from '../robot-client';
import type { RobotClient } from '../robot-client/types';

const logger = createLogger('session');
import astronautSvg from '../assets/astronaut.svg';
import connectionLostSvg from '../assets/connection-lost.svg';
import rocketSvg from '../assets/rocket.svg';
import { FONT_WEIGHT, LAYOUT, STATUS, TYPO } from '../styles/tokens';

// ─── Types ────────────────────────────────────────────────────────────────

export type ConnectionTarget =
  | { kind: 'local'; device: ReachyBleDevice }
  | { kind: 'remote'; robot: CentralRobotEntry };

interface RobotSessionScreenProps {
  target: ConnectionTarget;
  /** HF username (for remote subtitle and the menu's identity row). */
  username: string | null;
  onBack: () => void;
  /** Local-only: robot has no Wi-Fi yet, route to setup. */
  onNeedsWifi?: () => void;
}

// ─── Step labels ─────────────────────────────────────────────────────────

const LOCAL_STEP_LABELS = ['Bluetooth', 'Network', 'Daemon', 'Conversation'] as const;
const REMOTE_STEP_LABELS = [
  'Hugging Face',
  'WebRTC',
  'Daemon',
  'Conversation',
] as const;

const HTTP_PROBE_TIMEOUT_MS = 4_000;
const TEARDOWN_TIMEOUT_MS = 3_500;

/**
 * Engine `AppState` values where the conversation UI should be
 * visible. Anything else is still considered "connecting" and the
 * stepper keeps the `Conversation` step active.
 *
 * `connected` is intentionally treated as live: for both flows the
 * engine has a preselected peerId and will auto-progress through
 * `connected → starting → listening` on its own; flipping to live
 * one tick early just makes the chrome appear ~50 ms sooner.
 */
const LIVE_ENGINE_STATES: ReadonlySet<AppState> = new Set([
  'connected',
  'authenticated',
  'signed-out',
  'listening',
  'user-speaking',
  'processing',
  'ai-speaking',
  'error',
]);

const TRANSIENT_ENGINE_STATES: ReadonlySet<AppState> = new Set([
  'connecting',
  'auto-selecting',
  'starting',
]);

// ─── Component ───────────────────────────────────────────────────────────

type Phase = 'handshake' | 'engine' | 'live' | 'leaving';

interface HandshakeError {
  failedAt: number;
  title: string;
  body: string;
  detail: string | null;
  /** Local-only: offer the "Set up WiFi" CTA (robot online but no ip). */
  offerWifiSetup: boolean;
}

export default function RobotSessionScreen({
  target,
  username,
  onBack,
  onNeedsWifi,
}: RobotSessionScreenProps) {
  const isLocal = target.kind === 'local';
  const stepLabels = isLocal ? LOCAL_STEP_LABELS : REMOTE_STEP_LABELS;
  const displayName =
    target.kind === 'local'
      ? target.device.name
      : extractRobotName(target.robot);

  // ── BLE session (local only) ──────────────────────────────────────────
  const {
    connectToDevice,
    disconnectDevice,
    readNetworkStatus,
    connectedAddress,
  } = useBleSession();

  // ── Phase + handshake state ──────────────────────────────────────────
  const [phase, setPhaseRaw] = useState<Phase>('handshake');
  // Wrap `setPhase` so every transition emits a structured log line.
  // `setPhase(prev => next)` is supported, but RobotSessionScreen only
  // ever uses the direct form, which keeps the wrapper simple.
  const setPhase = useCallback(
    (next: Phase) => {
      setPhaseRaw((prev) => {
        if (prev !== next) {
          logger.info('phase.transition', { from: prev, to: next });
        }
        return next;
      });
    },
    [],
  );

  // Mint a fresh trace-id for the entire session, propagated as
  // `X-Trace-Id` on every daemon HTTP call (PR-A, picked up by PR-B
  // on the daemon). One id per visit to this screen makes the log
  // story easy to follow: "this whole connection attempt was abc1".
  useEffect(() => {
    const trace = newTraceId();
    setTraceId(trace);
    logger.info('mount', {
      trace,
      target_kind: target.kind,
      target_id:
        target.kind === 'local'
          ? target.device.address
          : extractRobotId(target.robot),
    });
    return () => {
      logger.info('unmount');
      setTraceId(null);
    };
  }, [target]);
  const [activeStep, setActiveStep] = useState(0);
  const [handshakeError, setHandshakeError] = useState<HandshakeError | null>(
    null,
  );
  const [retryToken, setRetryToken] = useState(0);
  const [showHandshakeDetails, setShowHandshakeDetails] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);

  // ── Resolved daemon target after handshake ───────────────────────────
  // For local mode, the BLE handshake hands us an IP. For remote, there
  // is no host (the WebRTC client doesn't need one). Both feed
  // `createRobotClient` so the rest of the screen is transport-agnostic.
  const [resolvedDaemonHost, setResolvedDaemonHost] = useState<string | null>(
    null,
  );
  const remotePeerId =
    target.kind === 'remote' ? extractRobotId(target.robot) : null;

  // ── Engine state observed via ConversePanel ──────────────────────────
  const [engineState, setEngineState] = useState<AppState | null>(null);

  // ── Robot client (transport-agnostic) ────────────────────────────────
  // Built once we have either a daemon host (local) or know we're in
  // remote mode. The screen leans on this for daemon-API calls
  // (`useDaemonStatus`, `setDesiredState`) without caring how the bytes
  // travel under the hood.
  const robotClient = useMemo(() => {
    if (isLocal) {
      if (!resolvedDaemonHost) return null;
      return createRobotClient({
        daemonHost: resolvedDaemonHost,
        remoteMode: false,
      });
    }
    return createRobotClient({ daemonHost: null, remoteMode: true });
  }, [isLocal, resolvedDaemonHost]);

  // ── Daemon status pill + step 3 advance for remote ───────────────────
  const daemonProbe = useDaemonStatus(robotClient, {
    pollMs: phase === 'live' ? 5_000 : 1_500,
  });

  // ── One-shot daemon version probe ─────────────────────────────────────
  // Runs as soon as we have a client. The result is purely advisory:
  // it drives the OutdatedDaemonBanner above the conversation area
  // when the daemon is older than the mobile app expects. Failures
  // (network, 404 on old daemons) are logged at WARN by the probe
  // itself and don't surface in the UI beyond the banner.
  const [daemonVersion, setDaemonVersion] = useState<DaemonVersionInfo | null>(
    null,
  );
  useEffect(() => {
    if (!robotClient) return;
    let cancelled = false;
    void (async () => {
      const info = await probeDaemonVersion(robotClient);
      if (cancelled) return;
      setDaemonVersion(info);
    })();
    return () => {
      cancelled = true;
    };
  }, [robotClient]);

  // ── Local HF auth (LAN flow only) ────────────────────────────────────
  // The LAN path requires the daemon to hold an HF token (so its relay
  // can register on central). We surface a sign-in card if it's
  // missing. Remote mode has the user's token directly in
  // sessionStorage and skips this entirely.
  const auth = useHfAuth(isLocal ? resolvedDaemonHost : null);
  const isAuthenticated = isLocal ? auth.isAuthenticated : true;

  // ── Handshake runner ──────────────────────────────────────────────────
  // For local: BLE → Network → Daemon HTTP probe (3 sequential steps).
  // For remote: skip - the peerId was already validated when the user
  // saw the robot in the unified ScanScreen, so we mark the first
  // step done and immediately drop into the engine phase.
  useEffect(() => {
    if (phase !== 'handshake') return;
    let cancelled = false;
    setHandshakeError(null);
    setShowHandshakeDetails(false);
    setActiveStep(0);

    if (!isLocal) {
      if (target.kind !== 'remote') return;
      const peerId = extractRobotId(target.robot);
      if (!peerId) {
        setHandshakeError({
          failedAt: 0,
          title: 'No peer id for this robot',
          body: 'Hugging Face central did not return a usable peer id. Try refreshing the list.',
          detail: JSON.stringify(target.robot, null, 2),
          offerWifiSetup: false,
        });
        return;
      }
      // Step 1 (Hugging Face) is done as soon as we land here.
      setActiveStep(1);
      setPhase('engine');
      return;
    }

    if (target.kind !== 'local') return;
    const device = target.device;

    void (async () => {
      // Step 0: BLE handshake.
      if (connectedAddress !== device.address) {
        const ok = await connectToDevice(device);
        if (cancelled) return;
        if (!ok) {
          setHandshakeError({
            failedAt: 0,
            title: "Couldn't open the Bluetooth session",
            body: 'The robot rejected or timed out the connection attempt.',
            detail: null,
            offerWifiSetup: false,
          });
          return;
        }
      }
      if (cancelled) return;
      setActiveStep(1);

      // Step 1: read network status over BLE.
      let ns: NetworkStatus;
      try {
        ns = await readNetworkStatus();
      } catch (err) {
        if (cancelled) return;
        setHandshakeError({
          failedAt: 1,
          title: "Couldn't read the robot's status",
          body: 'Try again, or restart the robot if the issue persists.',
          detail: err instanceof Error ? err.message : String(err),
          offerWifiSetup: false,
        });
        return;
      }
      if (cancelled) return;
      setActiveStep(2);

      // Step 2: daemon HTTP probe (LAN reachability + alive).
      if (!ns.ip) {
        setHandshakeError({
          failedAt: 2,
          title: 'Robot is not on a Wi-Fi yet',
          body: "Let's set one up.",
          detail: `NETWORK_STATUS: mode=${ns.mode || 'unknown'}, ip=null`,
          offerWifiSetup: true,
        });
        return;
      }

      try {
        const resp = await daemonFetch(ns.ip, '/api/daemon/status', {
          timeoutMs: HTTP_PROBE_TIMEOUT_MS,
        });
        if (cancelled) return;
        if (!resp.ok) {
          setHandshakeError({
            failedAt: 2,
            title: "Can't reach the daemon",
            body: "The robot is online but this phone can't reach it - you're probably on a different Wi-Fi.",
            detail: `HTTP ${resp.status} at ${ns.ip}:${ns.port}`,
            offerWifiSetup: true,
          });
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setHandshakeError({
          failedAt: 2,
          title: "Can't reach the daemon",
          body: "The robot is online but this phone can't reach it - you're probably on a different Wi-Fi.",
          detail: err instanceof Error ? err.message : String(err),
          offerWifiSetup: true,
        });
        return;
      }

      if (cancelled) return;
      setActiveStep(3);
      setResolvedDaemonHost(ns.ip);
      setPhase('engine');
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, retryToken, target]);

  // ── Engine state observer (steps 1-3 for remote, step 3 for local) ───
  // We translate engine transitions into step advances:
  //   - Remote step 1 ('WebRTC') done when engine leaves the
  //     `connecting` state (signaling completed, PC negotiated).
  //   - Remote step 2 ('Daemon') is driven by `daemonProbe` (see
  //     effect below).
  //   - Both modes step 3 ('Conversation') done when engine reaches
  //     a live state, which flips us to phase 'live'.
  useEffect(() => {
    if (engineState === null) return;
    if (phase !== 'engine') return;
    if (LIVE_ENGINE_STATES.has(engineState)) {
      setActiveStep(stepLabels.length);
      setPhase('live');
    }
  }, [engineState, phase, stepLabels.length, setPhase]);

  // Remote-only: advance the 'WebRTC' and 'Daemon' steps based on
  // engine state and daemon-status probe. In local mode steps 0-2 are
  // already advanced by the handshake runner above and step 3 by
  // engine state alone.
  useEffect(() => {
    if (isLocal) return;
    if (phase !== 'engine') return;
    let next = activeStep;
    if (
      engineState !== null &&
      !TRANSIENT_ENGINE_STATES.has(engineState) &&
      activeStep < 2
    ) {
      next = 2;
    }
    if (daemonProbe.kind === 'ok' && next < 3) {
      next = 3;
    }
    if (next !== activeStep) setActiveStep(next);
  }, [engineState, daemonProbe.kind, phase, activeStep, isLocal]);

  // ── Wake / sleep on phase transitions ────────────────────────────────
  // Wake on entering 'live'. Sleep is requested on the back path
  // (handleBack) and awaited with a timeout before unmount completes.
  useEffect(() => {
    if (phase !== 'live') return;
    if (!robotClient) return;
    setDesiredState(robotClient, 'awake');
  }, [phase, robotClient]);

  // ── Back navigation with graceful teardown ───────────────────────────
  const handleBack = useCallback(() => {
    setPhase('leaving');
  }, [setPhase]);

  useEffect(() => {
    if (phase !== 'leaving') return;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutHandle);
      onBack();
    };
    const timeoutHandle = window.setTimeout(finish, TEARDOWN_TIMEOUT_MS);

    if (robotClient) {
      // Queue the sleep request. The store coalesces it with any
      // pending wake from the live phase, so the robot reliably
      // ends up disabled even if wake hadn't completed.
      setDesiredState(robotClient, 'sleeping');
    }

    void (async () => {
      // Best effort, sequential to avoid stepping on each other:
      //   1. Engine teardown lands `endSession` on central while
      //      the WebRTC tunnel is still alive (remote) or the LAN
      //      HTTP path is still up (local).
      //   2. Motion store flush waits for `goto_sleep` + disable
      //      motors to land. Through the same client, so it shares
      //      the transport with the engine.
      //   3. BLE disconnect happens last - it severs the path the
      //      goto_sleep POST was just travelling on (LAN), so we
      //      really do need it after step 2.
      try {
        await flushEngineLifecycle();
      } catch {
        // best-effort
      }
      try {
        await flushMotionPending();
      } catch {
        // best-effort
      }
      if (isLocal && connectedAddress) {
        try {
          await disconnectDevice();
        } catch {
          // best-effort
        }
      }
      finish();
    })();

    return () => {
      // Effect tear-down only runs when `phase` flips off 'leaving'
      // (e.g. parent forced a re-route). Treat as a hard cancel:
      // the component is gone, nothing more to do.
      settled = true;
      window.clearTimeout(timeoutHandle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const handleRetry = useCallback(() => {
    setRetryToken((v) => v + 1);
    setHandshakeError(null);
    setActiveStep(0);
    setPhase('handshake');
  }, [setPhase]);

  // ── Subtitle for top bar / handshake header ──────────────────────────
  const subtitle = useMemo(() => {
    if (isLocal) {
      if (resolvedDaemonHost) return resolvedDaemonHost;
      if (target.kind === 'local' && target.device.name)
        return target.device.name;
      return 'Bluetooth';
    }
    return username ? `Signed in as ${username}` : 'Over the internet';
  }, [isLocal, resolvedDaemonHost, target, username]);

  // ── Conversation panel mounting ──────────────────────────────────────
  // Mount as soon as we have prerequisites, even before phase==='live'.
  // It becomes visible only on phase==='live' but stays mounted so its
  // engine doesn't tear down between phases. Hidden via CSS so all
  // refs/timers/WebRTC stay alive.
  const shouldMountPanel =
    phase === 'engine' || phase === 'live' || phase === 'leaving';

  return (
    <Stack sx={{ height: '100%', bgcolor: 'background.default' }}>
      {/* Header is the same shape regardless of phase, so the user
          never sees a layout reflow. The chrome on the right (menu
          dot vs none) toggles inside this single component. */}
      <SessionTopBar
        robotName={displayName}
        subtitle={subtitle}
        onBack={handleBack}
        backDisabled={phase === 'leaving'}
        showMenu={phase === 'live'}
        isLocal={isLocal}
        onForgetWifi={() => setForgetOpen(true)}
        onDisconnect={handleBack}
        auth={auth}
      />

      {/* Stepper visible during handshake + engine phases. Keep its
          height stable so the swap from "stepper view" to "panel
          view" doesn't reshuffle the page. */}
      {(phase === 'handshake' || phase === 'engine') && (
        <Box sx={{ px: 3, pt: 2, pb: 1, bgcolor: 'background.default' }}>
          <StepperHeader
            steps={stepLabels as unknown as readonly string[]}
            activeStep={activeStep}
            error={handshakeError !== null}
          />
        </Box>
      )}

      {/* Body: handshake stepper + hero, or conversation panel. The
          ConversePanel is mounted in both cases when applicable, but
          hidden during handshake/engine phases - we just dim the
          area with a centred spinner over it so the underlying SDK
          can keep negotiating. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Handshake / waiting overlay. Sits above the panel during
            phases where we don't want the user to see the engine UI
            yet. */}
        {phase !== 'live' && (
          <Stack
            alignItems="center"
            justifyContent="center"
            spacing={2.5}
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 2,
              bgcolor: 'background.default',
              px: 3,
              pb: 4,
              textAlign: 'center',
            }}
          >
            {phase === 'leaving' ? (
              <>
                <CircularProgress size={28} />
                <Typography variant="body2" color="text.secondary">
                  Disconnecting…
                </Typography>
              </>
            ) : handshakeError ? (
              <HandshakeFailureView
                error={handshakeError}
                showDetails={showHandshakeDetails}
                onToggleDetails={() => setShowHandshakeDetails((v) => !v)}
                onRetry={handleRetry}
                onWifiSetup={onNeedsWifi}
              />
            ) : (
              <HandshakeRunningView
                stepLabel={stepLabels[Math.min(activeStep, stepLabels.length - 1)]}
                robotName={displayName}
                phase={phase}
              />
            )}
          </Stack>
        )}

        {/* Live chrome: bottom-nav tabs visible only in live phase. */}
        {shouldMountPanel ? (
          <ConversationArea
            phase={phase}
            isLocal={isLocal}
            isAuthenticated={isAuthenticated}
            daemonHost={resolvedDaemonHost}
            remotePeerId={remotePeerId}
            robotClient={robotClient}
            daemonProbeLabel={isLocal ? 'LAN' : 'WebRTC'}
            daemonProbe={daemonProbe}
            daemonVersion={daemonVersion}
            authLogin={() => void auth.login()}
            authIsLoading={auth.isLoading}
            authIsWaitingForAuth={auth.isWaitingForAuth}
            authError={auth.error}
            onAppStateChange={setEngineState}
          />
        ) : null}
      </Box>

      {/* Forget Wi-Fi dialog. Available for both LAN and remote
          sessions thanks to `RobotClient`: the dialog drives the
          flow over whatever transport the rest of the screen uses
          (LAN HTTP locally, `http_proxy` data channel for remote).
          Success re-uses the same back path as a manual disconnect
          so the robot still gets `goto_sleep` + `endSession` on the
          way out, before the network change kicks in. */}
      <ForgetWifiDialog
        open={forgetOpen}
        robotName={displayName}
        client={robotClient}
        onClose={() => setForgetOpen(false)}
        onForgotten={() => {
          setForgetOpen(false);
          handleBack();
        }}
      />
    </Stack>
  );
}

// ─── Top bar ──────────────────────────────────────────────────────────

const glowKf = keyframes`
  0%, 100% { box-shadow: 0 0 0 0 rgba(46, 204, 113, 0.55); }
  50% { box-shadow: 0 0 0 4px rgba(46, 204, 113, 0); }
`;

interface SessionTopBarProps {
  robotName: string;
  subtitle: string;
  onBack: () => void;
  backDisabled: boolean;
  showMenu: boolean;
  isLocal: boolean;
  onForgetWifi: () => void;
  onDisconnect: () => void;
  auth: ReturnType<typeof useHfAuth>;
}

function SessionTopBar({
  robotName,
  subtitle,
  onBack,
  backDisabled,
  showMenu,
  isLocal,
  onForgetWifi,
  onDisconnect,
  auth,
}: SessionTopBarProps) {
  const theme = useTheme();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.25}
      sx={{
        px: 2,
        py: 1,
        pt: 5.5,
        borderBottom: `1px solid ${theme.palette.divider}`,
        flexShrink: 0,
        bgcolor: 'background.default',
      }}
    >
      <IconButton
        size="small"
        onClick={onBack}
        disabled={backDisabled}
        aria-label="Back"
      >
        <ArrowBackIcon fontSize="small" />
      </IconButton>
      <Box
        sx={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          bgcolor: showMenu ? 'success.main' : 'text.disabled',
          animation: showMenu ? `${glowKf} 2s infinite` : 'none',
          flexShrink: 0,
        }}
      />
      <Stack sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
          {robotName}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          fontFamily="monospace"
          noWrap
        >
          {subtitle}
        </Typography>
      </Stack>
      {showMenu ? (
        <>
          <IconButton
            size="small"
            onClick={(e) => setMenuAnchor(e.currentTarget)}
            aria-label="More options"
          >
            <MoreVertIcon fontSize="small" />
          </IconButton>
          <Menu
            anchorEl={menuAnchor}
            open={menuAnchor !== null}
            onClose={() => setMenuAnchor(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            slotProps={{ paper: { sx: { minWidth: 240 } } }}
          >
            {isLocal ? (
              <HfAuthMenuItem
                auth={auth}
                onDone={() => setMenuAnchor(null)}
              />
            ) : null}
            {isLocal ? <Divider /> : null}
            {/* Available for both transports since PR-F. The remote
                path drives the same daemon endpoints through the
                WebRTC HTTP proxy. */}
            <MenuItem
              onClick={() => {
                setMenuAnchor(null);
                onForgetWifi();
              }}
            >
              <ListItemIcon>
                <DeleteOutlineIcon fontSize="small" color="warning" />
              </ListItemIcon>
              <ListItemText
                primary="Forget Wi-Fi"
                secondary="Robot will reopen its hotspot"
                primaryTypographyProps={{ fontWeight: 600 }}
                secondaryTypographyProps={{ fontSize: '0.7rem' }}
              />
            </MenuItem>
            <Divider />
            <MenuItem
              onClick={() => {
                setMenuAnchor(null);
                onDisconnect();
              }}
            >
              <ListItemIcon>
                <LinkOffIcon fontSize="small" color="error" />
              </ListItemIcon>
              <ListItemText
                primary="Disconnect from robot"
                primaryTypographyProps={{
                  fontWeight: 600,
                  color: 'error.main',
                }}
              />
            </MenuItem>
          </Menu>
        </>
      ) : null}
    </Stack>
  );
}

// ─── HF auth menu entry (local only) ──────────────────────────────────

function HfAuthMenuItem({
  auth,
  onDone,
}: {
  auth: ReturnType<typeof useHfAuth>;
  onDone: () => void;
}) {
  const { isAuthenticated, username, avatarUrl, isWaitingForAuth, isLoading } =
    auth;

  if (isAuthenticated) {
    return (
      <MenuItem
        onClick={() => {
          void auth.logout();
          onDone();
        }}
      >
        <ListItemIcon>
          <Avatar
            src={avatarUrl ?? undefined}
            sx={{ width: 26, height: 26, fontSize: 12 }}
          >
            {username?.[0]?.toUpperCase() ?? '?'}
          </Avatar>
        </ListItemIcon>
        <ListItemText
          primary={username ?? 'Hugging Face'}
          secondary="Sign out"
          primaryTypographyProps={{ fontWeight: 600 }}
          secondaryTypographyProps={{ fontSize: '0.7rem' }}
        />
        <LogoutIcon fontSize="small" color="action" sx={{ ml: 1 }} />
      </MenuItem>
    );
  }

  const busy = isLoading || isWaitingForAuth;

  return (
    <MenuItem
      disabled={busy}
      onClick={() => {
        void auth.login();
        onDone();
      }}
    >
      <ListItemIcon>
        {busy ? <CircularProgress size={16} /> : <LoginIcon fontSize="small" />}
      </ListItemIcon>
      <ListItemText
        primary={busy ? 'Waiting for login…' : 'Sign in with Hugging Face'}
        secondary={busy ? 'Finish in your browser' : 'Needed to start a conversation'}
        primaryTypographyProps={{ fontWeight: 600 }}
        secondaryTypographyProps={{ fontSize: '0.7rem' }}
      />
    </MenuItem>
  );
}

// ─── Handshake views ──────────────────────────────────────────────────

function HandshakeRunningView({
  stepLabel,
  robotName,
  phase,
}: {
  stepLabel: string;
  robotName: string;
  phase: Phase;
}) {
  return (
    <>
      <HeroIllustration
        src={phase === 'engine' ? rocketSvg : astronautSvg}
        alt={robotName}
        animation={phase === 'engine' ? 'pulse' : 'float'}
        size={LAYOUT.heroSize}
        mb={0.5}
      />
      <Typography
        sx={{
          fontSize: TYPO.xl,
          fontWeight: FONT_WEIGHT.semibold,
          letterSpacing: '-0.2px',
          maxWidth: '100%',
        }}
        noWrap
      >
        {robotName}
      </Typography>
      <Stack alignItems="center" spacing={1}>
        <CircularProgress size={18} thickness={4} />
        <Typography sx={{ fontSize: TYPO.md, color: 'text.secondary' }}>
          {phase === 'engine' ? 'Starting conversation…' : `${stepLabel}…`}
        </Typography>
      </Stack>
    </>
  );
}

function HandshakeFailureView({
  error,
  showDetails,
  onToggleDetails,
  onRetry,
  onWifiSetup,
}: {
  error: HandshakeError;
  showDetails: boolean;
  onToggleDetails: () => void;
  onRetry: () => void;
  onWifiSetup?: () => void;
}) {
  return (
    <>
      <HeroIllustration
        src={connectionLostSvg}
        alt="Connection lost"
        animation="float"
        size={LAYOUT.heroSize}
        mb={0.5}
      />
      <Typography
        sx={{
          fontSize: TYPO.xl,
          fontWeight: FONT_WEIGHT.semibold,
          color: 'text.primary',
        }}
      >
        {error.title}
      </Typography>
      <Typography
        sx={{
          fontSize: TYPO.sm,
          color: 'text.secondary',
          lineHeight: 1.5,
          maxWidth: 320,
        }}
      >
        {error.body}
      </Typography>
      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 320, pt: 1 }}>
        {error.offerWifiSetup && onWifiSetup ? (
          <button
            onClick={onWifiSetup}
            style={{
              all: 'unset',
              cursor: 'pointer',
              padding: '12px 16px',
              borderRadius: 8,
              backgroundColor: STATUS.info,
              color: '#fff',
              fontWeight: 600,
              textAlign: 'center',
              fontSize: '0.95rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              justifyContent: 'center',
            }}
          >
            <WifiIcon fontSize="small" /> Set up Wi-Fi
          </button>
        ) : null}
        <button
          onClick={onRetry}
          style={{
            all: 'unset',
            cursor: 'pointer',
            padding: '10px 16px',
            borderRadius: 8,
            border: `1px solid ${STATUS.info}`,
            color: STATUS.info,
            fontWeight: 500,
            textAlign: 'center',
            fontSize: '0.9rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            justifyContent: 'center',
          }}
        >
          <ReplayIcon fontSize="small" /> Retry
        </button>
        {error.detail ? (
          <Box sx={{ textAlign: 'center', pt: 0.5 }}>
            <button
              onClick={onToggleDetails}
              style={{
                all: 'unset',
                cursor: 'pointer',
                opacity: 0.6,
                fontSize: TYPO.xs,
                padding: '4px 8px',
              }}
            >
              {showDetails ? 'Hide details' : 'Details'}
            </button>
            <Collapse in={showDetails}>
              <Typography
                sx={{
                  display: 'block',
                  fontSize: TYPO.xs,
                  color: 'text.secondary',
                  fontFamily: 'monospace',
                  mt: 1,
                  p: 1.5,
                  borderRadius: 1,
                  bgcolor: 'action.hover',
                  wordBreak: 'break-all',
                  textAlign: 'left',
                }}
              >
                {error.detail}
              </Typography>
            </Collapse>
          </Box>
        ) : null}
      </Stack>
    </>
  );
}

// ─── Conversation area (live phase) ───────────────────────────────────

interface ConversationAreaProps {
  phase: Phase;
  isLocal: boolean;
  isAuthenticated: boolean;
  daemonHost: string | null;
  remotePeerId: string | null;
  /**
   * Transport-agnostic client. AppsPanel uses it to fetch the HF
   * token from the daemon; with PR-F the Apps tab is no longer
   * gated on `isLocal` because the WebRTC `http_proxy` path makes
   * the same daemon endpoint reachable remotely.
   */
  robotClient: RobotClient | null;
  daemonProbeLabel: string;
  daemonProbe: ReturnType<typeof useDaemonStatus>;
  /** PR-D: surfaces the outdated-daemon banner when applicable. */
  daemonVersion: DaemonVersionInfo | null;
  authLogin: () => void;
  authIsLoading: boolean;
  authIsWaitingForAuth: boolean;
  authError: string | null;
  onAppStateChange: (s: AppState) => void;
}

function ConversationArea({
  phase,
  isLocal,
  isAuthenticated,
  daemonHost,
  remotePeerId,
  robotClient,
  daemonProbeLabel,
  daemonProbe,
  daemonVersion,
  authLogin,
  authIsLoading,
  authIsWaitingForAuth,
  authError,
  onAppStateChange,
}: ConversationAreaProps) {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<'converse' | 'apps'>('converse');

  // PR-F: Apps tab now lives behind RobotClient, so it's available
  // remotely too. The only gate left is "user is signed in", which
  // applies in both modes (LAN: daemon-side HF token; remote:
  // mobile-side HF token forwarded into the iframe by AppsPanel).
  const showAppsTab = isAuthenticated && robotClient !== null;
  const visible = phase === 'live';

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: theme.palette.background.paper,
      }}
    >
      {/* HF login overlay (LAN only) - same behaviour as the legacy
          ConnectedScreen: covers the panel until the daemon's HF flow
          completes. We render it inside the live area so the stepper
          on top stays the only chrome the user sees in the handshake
          phase. */}
      {isLocal && !isAuthenticated && phase === 'live' ? (
        <HfLoginOverlay
          onLogin={authLogin}
          isLoading={authIsLoading}
          isWaitingForAuth={authIsWaitingForAuth}
          error={authError}
        />
      ) : (
        <>
          {visible && daemonVersion?.outdated ? (
            <OutdatedDaemonBanner daemonVersion={daemonVersion.version} />
          ) : null}
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: activeTab === 'converse' ? 'flex' : 'none',
              flexDirection: 'column',
              position: 'relative',
            }}
          >
            <ConversePanel
              daemonHost={daemonHost}
              isAuthenticated={isAuthenticated}
              remoteMode={!isLocal}
              remotePeerId={remotePeerId}
              onAppStateChange={onAppStateChange}
            />
            {visible ? (
              <Box
                sx={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  zIndex: 2,
                  maxWidth: 'calc(100% - 16px)',
                  pointerEvents: 'none',
                }}
              >
                <DaemonStatusPill
                  probe={daemonProbe}
                  transportLabel={daemonProbeLabel}
                />
              </Box>
            ) : null}
          </Box>
          {showAppsTab ? (
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                display: activeTab === 'apps' ? 'flex' : 'none',
                flexDirection: 'column',
              }}
            >
              <AppsPanel
                client={robotClient}
                isAuthenticated={isAuthenticated}
              />
            </Box>
          ) : null}
        </>
      )}
      {visible && showAppsTab ? (
        <BottomNavigation
          showLabels
          value={activeTab}
          onChange={(_, value) => setActiveTab(value as 'converse' | 'apps')}
          sx={{
            borderTop: `1px solid ${theme.palette.divider}`,
            flexShrink: 0,
          }}
        >
          <BottomNavigationAction
            value="converse"
            label="Converse"
            icon={<GraphicEqIcon />}
          />
          <BottomNavigationAction
            value="apps"
            label="Apps"
            icon={<AppsIcon />}
          />
        </BottomNavigation>
      ) : null}
    </Box>
  );
}

