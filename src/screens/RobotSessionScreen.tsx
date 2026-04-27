/**
 * Unified post-discovery screen for both LAN (BLE) and remote (HF
 * central) connections.
 *
 * Single transport, two discovery paths
 * ─────────────────────────────────────
 * BLE and HF central are two ways to FIND a robot, not two ways to
 * TALK to it. Once we land on this screen, every daemon API call goes
 * through the same WebRTC `http_proxy` channel (see
 * `robot-client/index.ts`). ICE quietly picks a LAN host candidate
 * when both peers are on the same subnet and a TURN-relayed remote
 * one otherwise, so "prefer LAN when reachable" is automatic without
 * dual code paths.
 *
 * BLE keeps a small but real role even after this collapse:
 *   - Wi-Fi provisioning (the user can hand the robot credentials
 *     before central can see it at all).
 *   - Proof of physical proximity (the BLE list is curated by who is
 *     literally next to the robot, central is curated by the HF
 *     account that owns it).
 *   - Local-side bootstraps that need direct LAN HTTP because the
 *     daemon does not yet hold an HF token (auto-seed of `/api/hf-
 *     auth/save-token`, the daemon-mediated OAuth menu in `useHfAuth`).
 *     Those are intentionally narrow side-channels; everything else
 *     lives on the WebRTC client.
 *
 * Why a stepper at all
 * ────────────────────
 *   - LAN: `Bluetooth → Network → Daemon → Wake up`. Network is
 *     "Wi-Fi configured + IP visible over BLE" (proof we can reach
 *     central at all). Daemon is "WebRTC DC open + `/daemon/status`
 *     probe ok over the proxy".
 *   - Remote: `Hugging Face → WebRTC → Daemon → Wake up`. Same Daemon
 *     step semantics, different first two beats (peer id from central
 *     instead of BLE handshake).
 * Both surfaces resolve to the same `'engine' → 'ready'` transition
 * when the WebRTC tunnel is up and the daemon probe lands.
 *
 * Phase machine
 * ─────────────
 *   'handshake' → BLE/peer-id pre-checks. On failure, retry / wifi-
 *                 setup affordances appear.
 *   'engine'    → Conversation engine mounted (its DataChannel IS
 *                 the daemon transport). Wake-up sequence fires once
 *                 the DC is open and the daemon probe is healthy.
 *   'ready'     → Wake-up complete, motors online. We surface a CTA
 *                 ("Start conversation"). The startup pipeline ENDS
 *                 here on purpose: starting the conversation is a
 *                 deliberate user action, not part of bring-up.
 *   'live'      → User tapped the CTA. The conversation UI becomes
 *                 visible; the engine that's already been running in
 *                 the background simply unhides.
 *   'leaving'   → Back tapped. We unmount ConversePanel (engine
 *                 teardown lands `endSession` on central) and queue
 *                 `setDesiredState('sleeping')`. Both flushes are
 *                 awaited with a hard timeout before yielding to the
 *                 parent's `onBack`.
 *
 * Wake-up timing (foreground, gating)
 * ───────────────────────────────────
 * Wake-up gates the stepper's last step in both modes. We fire
 * `setDesiredState('awake')` once the engine has left its transient
 * states AND the daemon probe is healthy, then await `flushPending()`
 * before flipping to 'ready'. The user sees the "Wake up" step go
 * from active → completed exactly as the robot finishes the wake_up
 * trajectory, which is a much clearer "everything is ready" signal
 * than spinning while a hidden engine negotiates.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Avatar,
  Box,
  BottomNavigation,
  BottomNavigationAction,
  Button,
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
import OutdatedDaemonBanner from '../components/OutdatedDaemonBanner';
import SessionBanner from '../components/SessionBanner';
import StepperHeader from '../components/StepperHeader';
import { useSessionHealth } from '../session/useSessionHealth';
import { AppsPanel } from '../conversation/AppsPanel';
import {
  ConversePanel,
  flushEngineLifecycle,
} from '../conversation/ConversePanel';
import type { AppState } from '../conversation/conversation-engine';
import { useReachySdk } from '../conversation/useReachySdk';
import { useRobotPeerId } from '../conversation/useRobotPeerId';
import { daemonFetch } from '../daemon/daemonFetch';
import {
  probeDaemonVersion,
  type DaemonVersionInfo,
} from '../daemon/daemonProbeVersion';
import {
  flushPending as flushMotionPending,
  setDesiredState,
} from '../daemon/robotMotion';
import { useDaemonRelayHealing } from '../daemon/useDaemonRelayHealing';
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
  /**
   * HF access token from the app-level gate. Used in LAN mode to
   * silently seed the daemon's own HF auth via `POST
   * /api/hf-auth/save-token` the first time we connect, so the user
   * does not see a second sign-in prompt for what is conceptually
   * the same account.
   */
  hfToken: string | null;
  onBack: () => void;
  /** Local-only: robot has no Wi-Fi yet, route to setup. */
  onNeedsWifi?: () => void;
}

// ─── Step labels ─────────────────────────────────────────────────────────

const LOCAL_STEP_LABELS = ['Bluetooth', 'Network', 'Daemon', 'Wake up'] as const;
const REMOTE_STEP_LABELS = [
  'Hugging Face',
  'WebRTC',
  'Daemon',
  'Wake up',
] as const;

/**
 * Watchdog ceiling for the leaving phase. Sized so the teardown can fit:
 *
 *   - up to ~2.5 s of an in-flight `wake_up.json` trajectory we'd
 *     coalesce-cancel by queueing `sleeping` (the worst case is the
 *     user hitting Disconnect mid wake-up),
 *   - the full ~2 s of `goto_sleep.json`,
 *   - the `set_mode/disabled` POST, plus engine endSession / DC close.
 *
 * Anything longer would feel like the back button is stuck; anything
 * shorter clips goto_sleep and leaves the robot frozen mid-trajectory
 * with motors disabled, so it slumps under gravity from a non-rest
 * pose.
 */
const TEARDOWN_TIMEOUT_MS = 5_500;

/**
 * Engine `AppState` values that mean the WebRTC tunnel is still
 * being negotiated. We avoid sending wake-up POSTs through the
 * data-channel until the engine has left this set, otherwise the
 * first proxy request races with the `gst-webrtc` connection
 * setup and we waste a 4 s timeout on a dead-on-arrival POST.
 */
const TRANSIENT_ENGINE_STATES: ReadonlySet<AppState> = new Set([
  'connecting',
  'auto-selecting',
  'starting',
]);

// ─── Component ───────────────────────────────────────────────────────────

type Phase = 'handshake' | 'engine' | 'ready' | 'live' | 'leaving';

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
  hfToken,
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

  // ── BLE-side LAN IP (narrow side-channel) ────────────────────────────
  // Captured during the LOCAL handshake from `NETWORK_STATUS`. Not used
  // for the main daemon transport (that's WebRTC) - only for the
  // bootstrap calls that legitimately need a direct LAN socket: the
  // daemon-mediated HF OAuth flow (`useHfAuth`, redirect URI lives on
  // `reachy-mini.local:8000`) and the auto-seed of `/api/hf-auth/save-
  // token` for daemons that don't yet hold an HF token. REMOTE robots
  // can't surface their LAN IP to us so those bootstraps are skipped.
  const [bleNetworkIp, setBleNetworkIp] = useState<string | null>(null);
  const remotePeerId =
    target.kind === 'remote' ? extractRobotId(target.robot) : null;

  // ── Engine state observed via ConversePanel ──────────────────────────
  const [engineState, setEngineState] = useState<AppState | null>(null);

  // ── Robot client (single WebRTC transport) ───────────────────────────
  // Built once at mount. The DC underneath gets installed by
  // `useReachySdk`/`ConversePanel` later; until then `client.fetch()`
  // returns synthetic 0-status responses, which the daemon-status pill
  // and other consumers already render as "connecting…". This is on
  // purpose: a single client instance + a single transport means the
  // rest of the screen is genuinely target-agnostic.
  const robotClient = useMemo(() => createRobotClient(), []);

  // ── Daemon status pill + step 3 advance for remote ───────────────────
  const daemonProbe = useDaemonStatus(robotClient, {
    pollMs: phase === 'live' ? 5_000 : 1_500,
  });

  // ── Eager SDK load ────────────────────────────────────────────────────
  // The ReachyMini JS SDK is a global singleton (`useReachySdk` is
  // backed by a module-level loader). Calling the hook here kicks off
  // the CDN fetch on screen mount, in parallel with the BLE / WebRTC
  // handshake, so by the time the user taps "Start conversation" the
  // SDK is already in memory and `ConversePanel` mounts the engine
  // synchronously. No spinner, no perceived latency.
  useReachySdk();

  // ── Peer id resolution (transport-agnostic) ──────────────────────────
  // Lift the peer-id fetch into the parent so `ConversePanel` stays a
  // pure renderer. LOCAL probes the daemon over LAN HTTP; REMOTE
  // short-circuits with the id central already gave us on the
  // discovery screen. The hook never throws: a network failure or a
  // zombie relay both resolve to `peerId: null, resolved: true`, and
  // the lazy heal trigger below recovers from that.
  const {
    peerId: resolvedPeerId,
    resolved: peerIdResolved,
    refresh: refreshPeerId,
  } = useRobotPeerId(robotClient, isLocal ? undefined : remotePeerId);

  // ── Lazy daemon-relay heal ───────────────────────────────────────────
  // Triggered by `handleEngineStuck` below when ConversePanel reports
  // the engine has been stuck in a transient state past the lazy heal
  // budget. The hook coalesces concurrent calls so two simultaneous
  // symptoms (peer id null + watchdog trip) only POST `/refresh-relay`
  // once.
  const {
    healing: relayHealing,
    lastHealth: relayHealth,
    triggerHeal: triggerRelayHeal,
  } = useDaemonRelayHealing(robotClient);

  // Bumped after a successful heal so ConversePanel rebuilds the
  // engine on the now-healthy relay. Without this, the engine would
  // keep its stale SSE connection to central and `startSession` would
  // either fail again or land on the wrong session.
  const [conversationRemountKey, setConversationRemountKey] = useState(0);

  const handleEngineStuck = useCallback(async (): Promise<void> => {
    logger.info('engine.stuck.detected');
    const result = await triggerRelayHeal();
    logger.info('engine.stuck.heal', {
      outcome: result.outcome,
      status: result.health.status,
    });
    // We only force a fresh engine on `healed`: that is the only
    // outcome where the daemon ↔ central handshake actually
    // changed, and the cached SSE / peer id we hold is now stale.
    //
    // - `noop` means the daemon was already healthy when the engine
    //   reported itself stuck. Most often this is a slow happy path
    //   (cold-start auth + WebRTC handshake stretches past
    //   `LAZY_HEAL_MS`). Bumping `remountKey` here would tear down
    //   an engine that is seconds away from `listening` and start
    //   the same slow path over from zero, potentially forever.
    // - `failed` / `unreachable` mean the heal didn't recover the
    //   relay. The user-facing watchdog (`WATCHDOG_TIMEOUT_MS` in
    //   the panel) ends up surfacing the retry CTA on its own; we
    //   don't loop the heal in the meantime.
    if (result.outcome === 'healed') {
      await refreshPeerId();
      setConversationRemountKey((k) => k + 1);
    }
  }, [triggerRelayHeal, refreshPeerId]);

  // Surface a hard-stop hint when the daemon doesn't ship the
  // `/refresh-relay` endpoint AND we observed a zombie state. The
  // user has to SSH in and restart manually; we render the
  // instruction inside ConversePanel's fatal-error overlay.
  const conversationErrorMessage = useMemo<string | null>(() => {
    if (!relayHealth) return null;
    if (
      relayHealth.status === 'zombie-relay' &&
      relayHealth.refreshEndpointAvailable === false
    ) {
      return "The robot's HuggingFace relay is out of sync and this version of the daemon cannot self-heal. SSH into the robot and run `sudo systemctl restart reachy-mini-daemon`, then retry.";
    }
    return null;
  }, [relayHealth]);

  const conversationBusyLabel = relayHealing
    ? 'Reconnecting robot to HuggingFace…'
    : null;

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

  // ── Session health (PR-E) ────────────────────────────────────────────
  // Fold the daemon probe + engine state into a single health bucket so
  // the live chrome can show a soft banner on degraded/lost without
  // forcing the user back to discovery on every transient flap.
  const sessionHealth = useSessionHealth(daemonProbe, engineState);

  // ── Local HF auth (LAN side-channel) ─────────────────────────────────
  // Daemon-mediated OAuth: the daemon registers a callback URL on
  // `reachy-mini.local:8000`, so the flow only makes sense when the
  // phone has a direct LAN line of sight (i.e. we got here via BLE
  // and `NETWORK_STATUS` gave us an IP). Remote robots have a token
  // pinned at central by definition (otherwise they wouldn't be in
  // the discovery list), so this hook stays idle there.
  const auth = useHfAuth(isLocal ? bleNetworkIp : null);
  const isAuthenticated = isLocal ? auth.isAuthenticated : true;

  // ── Auto-seed daemon HF token from the app gate (LAN only) ───────────
  // The user already authenticated at the app's entry gate
  // (`RemoteSignInScreen`), so showing a second OAuth surface for
  // the LAN daemon would be silly. Push our gate token to the
  // daemon the first time we land here authenticated app-side but
  // NOT daemon-side. If the daemon rejects it (revoked, wrong
  // scope, …) we log the failure and surface a sign-in entry in
  // the top-bar menu instead of taking over the screen with a
  // duplicate full-page login - the user is already signed in
  // app-wide, so the recovery path is to sign out at the gate and
  // back in, not to re-OAuth here.
  const [autoSeedAttempted, setAutoSeedAttempted] = useState(false);
  const {
    isLoading: authIsLoadingProbe,
    isAuthenticated: authIsAuthenticatedDaemon,
    refresh: authRefresh,
  } = auth;
  useEffect(() => {
    if (!isLocal) return;
    if (autoSeedAttempted) return;
    if (authIsLoadingProbe) return; // wait for the initial probe
    if (authIsAuthenticatedDaemon) {
      // Daemon-side init already done. Don't re-push the token.
      // Logged once so the skip is visible during E2E debugging.
      logger.info('auth.seed.skipped', { reason: 'daemon_already_authenticated' });
      setAutoSeedAttempted(true);
      return;
    }
    if (!hfToken) return; // no gate token to seed (shouldn't happen post-gate)
    if (!bleNetworkIp) return;

    setAutoSeedAttempted(true);
    let cancelled = false;
    void (async () => {
      try {
        logger.info('auth.seed.start', { host: bleNetworkIp });
        const resp = await daemonFetch(
          bleNetworkIp,
          '/api/hf-auth/save-token',
          {
            method: 'POST',
            body: JSON.stringify({ token: hfToken }),
            headers: { 'Content-Type': 'application/json' },
            timeoutMs: 6_000,
          },
        );
        if (cancelled) return;
        if (resp.ok) {
          logger.info('auth.seed.success');
          await authRefresh();
        } else {
          logger.warn('auth.seed.failure', { status: resp.status });
        }
      } catch (err) {
        if (cancelled) return;
        logger.warn('auth.seed.error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isLocal,
    autoSeedAttempted,
    authIsLoadingProbe,
    authIsAuthenticatedDaemon,
    authRefresh,
    hfToken,
    bleNetworkIp,
  ]);

  // ── Handshake runner ──────────────────────────────────────────────────
  // LOCAL: BLE connect → read NETWORK_STATUS to validate Wi-Fi presence.
  //   The "Daemon" step (#2) is no longer a direct HTTP probe: that
  //   transport is gone (everything goes through WebRTC now). We simply
  //   advance the stepper to step 2 and let the engine effect below drive
  //   the rest based on the WebRTC DC + daemon-status probe over the
  //   proxy. NETWORK_STATUS still earns its keep:
  //     - empty ip → robot has no Wi-Fi yet → offer Wi-Fi setup. Without
  //       Wi-Fi the robot can't reach HF central, so the WebRTC tunnel
  //       could never come up regardless of how long we waited.
  //     - non-empty ip → kept as `bleNetworkIp` for the LAN bootstraps
  //       (daemon HF auth seed + OAuth menu) that legitimately need a
  //       direct socket because they can't run over a tunnel that
  //       isn't built yet.
  // REMOTE: peerId was already validated when the user saw the robot in
  //   the unified ScanScreen. Mark step 0 done and drop into 'engine'.
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

      // Step 1: read network status over BLE. We need a non-empty ip
      // both as proof of Wi-Fi (without it central can't see the
      // robot) and as the host for the LAN HF-auth bootstraps.
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
      if (!ns.ip) {
        setHandshakeError({
          failedAt: 1,
          title: 'Robot is not on a Wi-Fi yet',
          body: "Let's set one up.",
          detail: `NETWORK_STATUS: mode=${ns.mode || 'unknown'}, ip=null`,
          offerWifiSetup: true,
        });
        return;
      }

      // Step 2 ('Daemon'): hand off to the engine. The WebRTC DC is
      // what the daemon-status probe rides; we don't attempt a
      // pre-flight HTTP probe here anymore because (a) the WebRTC
      // path is the source of truth and (b) a direct LAN HTTP from
      // the phone often hits captive-portal redirects on hotel /
      // co-working Wi-Fi while the WebRTC PeerConnection still wires
      // up cleanly via STUN.
      setActiveStep(2);
      setBleNetworkIp(ns.ip);
      setPhase('engine');
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, retryToken, target]);

  // ── Stepper progression in 'engine' phase ────────────────────────────
  // Both modes share this once they enter 'engine':
  //   - The penultimate step (LOCAL: 'Daemon', REMOTE: 'WebRTC') flips
  //     to "done" when the engine has left its transient set, i.e. the
  //     SDK has the DC open and is doing useful work.
  //   - The last visible step on the stepper before wake-up (LOCAL:
  //     activeStep 2, REMOTE: also 2) flips to "done" when the daemon
  //     status probe lands ok over the proxy. The 'Wake up' step (#3)
  //     is then handled by the wake-up effect below.
  useEffect(() => {
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
  }, [engineState, daemonProbe.kind, phase, activeStep]);

  // ── Wake-up sequence (gates the final step) ──────────────────────────
  // Fires once the WebRTC tunnel is up and the daemon probe is healthy,
  // for both LOCAL and REMOTE alike. Both modes route the wake POSTs
  // through the same `http_proxy` channel, so both have to wait for the
  // engine to leave its transient states (DC open) and for at least one
  // `/api/daemon/status` probe to land. When `flushPending` resolves we
  // know the daemon ran the wake_up trajectory to completion - that's
  // when we flip the stepper to "complete" and surface the 'Start
  // conversation' CTA.
  useEffect(() => {
    if (phase !== 'engine') return;
    const tunnelReady =
      daemonProbe.kind === 'ok' &&
      engineState !== null &&
      !TRANSIENT_ENGINE_STATES.has(engineState);
    if (!tunnelReady) return;

    let cancelled = false;
    setDesiredState(robotClient, 'awake');
    void (async () => {
      try {
        await flushMotionPending();
      } catch {
        // best-effort: even on failure we still want to unstick
        // the user from the stepper. The HF/Forget paths still
        // work, and re-arming the wake from the live screen is a
        // separate concern (handled by setDesiredState callers).
      }
      if (cancelled) return;
      setActiveStep(stepLabels.length);
      setPhase('ready');
    })();

    return () => {
      cancelled = true;
    };
  }, [
    phase,
    robotClient,
    daemonProbe.kind,
    engineState,
    stepLabels.length,
    setPhase,
  ]);

  // ── User-driven transition: 'ready' → 'live' ─────────────────────────
  // Triggered by the CTA in the 'ready' overlay. Encapsulated as a
  // memoized callback so the button can stay pure and we get a
  // single phase-transition log line.
  const handleStartConversation = useCallback(() => {
    setPhase('live');
  }, [setPhase]);

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

    // Queue the sleep request. The store coalesces it with any
    // pending wake from the live phase, so the robot reliably ends up
    // disabled even if wake hadn't completed.
    setDesiredState(robotClient, 'sleeping');

    void (async () => {
      // Best effort, sequential to avoid stepping on each other:
      //   1. Motion store flush waits for `goto_sleep` + disable
      //      motors to land. Goes through the WebRTC `http_proxy`,
      //      so we must run it BEFORE engine teardown rips the DC.
      //   2. Engine teardown lands `endSession` on central; this
      //      tears the DC down by design.
      //   3. BLE disconnect happens last - irrelevant for transport
      //      now that everything is on WebRTC, but still good
      //      hygiene so the next BLE pickup starts from a clean
      //      session.
      try {
        await flushMotionPending();
      } catch {
        // best-effort
      }
      try {
        await flushEngineLifecycle();
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
      if (bleNetworkIp) return bleNetworkIp;
      if (target.kind === 'local' && target.device.name)
        return target.device.name;
      return 'Bluetooth';
    }
    return username ? `Signed in as ${username}` : 'Over the internet';
  }, [isLocal, bleNetworkIp, target, username]);

  // ── Conversation panel mounting ──────────────────────────────────────
  // The WebRTC DataChannel hosted by `ConversePanel`'s engine IS the
  // daemon transport for both modes now, so the panel must be alive as
  // soon as we leave the handshake (so `useDaemonStatus`, `setDesired
  // State`, `probeDaemonVersion` and friends have a working tunnel).
  // The 'ready' phase keeps the engine mounted but covers it with the
  // 'Start conversation' CTA so the user is in the post-connect chrome
  // already, not still in the bring-up flow.
  const shouldMountPanel = phase !== 'handshake';

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
        showMenu={phase === 'ready' || phase === 'live'}
        isLocal={isLocal}
        onForgetWifi={() => setForgetOpen(true)}
        onDisconnect={handleBack}
        auth={auth}
      />

      {/* Stepper visible during handshake + engine only. Once the
          robot is awake ('ready' phase) we drop the stepper entirely
          and surface the final chrome (top-bar menu + bottom-nav
          tabs); the "Start conversation" CTA then lives inside the
          converse tab so the user is already in the post-connect
          surface, not still in the bring-up flow. */}
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
            yet. The 'ready' phase is intentionally NOT here: at that
            point we want the user inside the final chrome, with the
            "Start conversation" CTA living in the converse tab. */}
        {(phase === 'handshake' ||
          phase === 'engine' ||
          phase === 'leaving') && (
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
            isAuthenticated={isAuthenticated}
            robotName={displayName}
            robotClient={robotClient}
            peerId={resolvedPeerId}
            peerIdResolved={peerIdResolved}
            conversationRemountKey={conversationRemountKey}
            conversationBusyLabel={conversationBusyLabel}
            conversationErrorMessage={conversationErrorMessage}
            onEngineStuck={handleEngineStuck}
            daemonProbeLabel="WebRTC"
            daemonProbe={daemonProbe}
            daemonVersion={daemonVersion}
            sessionHealth={sessionHealth}
            onAppStateChange={setEngineState}
            onStartConversation={handleStartConversation}
            onRetry={handleRetry}
            onDisconnect={handleBack}
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
          {phase === 'engine' ? 'Waking up…' : `${stepLabel}…`}
        </Typography>
      </Stack>
    </>
  );
}

/**
 * Shown once bring-up is complete and the wake_up trajectory has
 * landed. We deliberately NOT auto-progress to the conversation
 * engine here: starting a conversation is a deliberate user
 * action, and gating it behind a tap also gives the daemon a
 * moment to settle (servo PWM steady, audio pipeline warmed up,
 * etc.) before the engine starts pumping audio.
 */
function HandshakeReadyView({
  robotName,
  onStart,
}: {
  robotName: string;
  onStart: () => void;
}) {
  return (
    <>
      <HeroIllustration
        src={rocketSvg}
        alt={robotName}
        animation="float"
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
      <Typography sx={{ fontSize: TYPO.md, color: 'text.secondary' }}>
        Ready to talk.
      </Typography>
      <Button
        variant="contained"
        size="large"
        startIcon={<GraphicEqIcon />}
        onClick={onStart}
        sx={{ mt: 1.5, minWidth: 220, fontWeight: FONT_WEIGHT.semibold }}
      >
        Start conversation
      </Button>
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
  /**
   * Daemon-side HF auth status. The user-facing OAuth gate lives in
   * `App.tsx` and is the single source of truth for "is the user
   * signed in to Hugging Face". This flag only reflects whether the
   * daemon ITSELF currently holds an HF token (auto-seeded on entry,
   * see the `auth.seed.*` flow in the parent). We use it solely to
   * gate the Apps tab in LAN mode, since the embedded apps need the
   * daemon-held token to make their own HF calls.
   */
  isAuthenticated: boolean;
  /** Robot display name, used by the in-tab "Start conversation" CTA. */
  robotName: string;
  /**
   * Transport-agnostic client. AppsPanel uses it to fetch the HF
   * token from the daemon; with PR-F the Apps tab is no longer
   * gated on `isLocal` because the WebRTC `http_proxy` path makes
   * the same daemon endpoint reachable remotely.
   */
  robotClient: RobotClient | null;
  /**
   * Pre-resolved central peer id. The parent owns resolution so the
   * panel never re-fetches it on mount.
   */
  peerId: string | null;
  peerIdResolved: boolean;
  /** Bumped by the parent post-heal to force the engine to remount. */
  conversationRemountKey: number;
  /** Soft overlay label (e.g. "Reconnecting…") while a heal is running. */
  conversationBusyLabel: string | null;
  /** Hard-stop overlay when the relay state is unrecoverable client-side. */
  conversationErrorMessage: string | null;
  /** Lazy-heal trigger fired by the panel's watchdog. */
  onEngineStuck: () => void;
  daemonProbeLabel: string;
  daemonProbe: ReturnType<typeof useDaemonStatus>;
  /** PR-D: surfaces the outdated-daemon banner when applicable. */
  daemonVersion: DaemonVersionInfo | null;
  /** PR-E: combined daemon + engine health for the SessionBanner. */
  sessionHealth: ReturnType<typeof useSessionHealth>;
  onAppStateChange: (s: AppState) => void;
  /** Trigger the 'ready' → 'live' transition from the in-tab CTA. */
  onStartConversation: () => void;
  onRetry: () => void;
  onDisconnect: () => void;
}

function ConversationArea({
  phase,
  isAuthenticated,
  robotName,
  robotClient,
  peerId,
  peerIdResolved,
  conversationRemountKey,
  conversationBusyLabel,
  conversationErrorMessage,
  onEngineStuck,
  daemonProbeLabel,
  daemonProbe,
  daemonVersion,
  sessionHealth,
  onAppStateChange,
  onStartConversation,
  onRetry,
  onDisconnect,
}: ConversationAreaProps) {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<'converse' | 'apps'>('converse');

  // PR-F: Apps tab now lives behind RobotClient, so it's available
  // remotely too. The only gate left is "user is signed in", which
  // applies in both modes (LAN: daemon-side HF token; remote:
  // mobile-side HF token forwarded into the iframe by AppsPanel).
  const showAppsTab = isAuthenticated && robotClient !== null;
  // Chrome (banner, tabs, daemon pill) is shown as soon as the robot
  // is awake. The engine is only mounted in 'live' for LOCAL though,
  // so 'ready' surfaces a CTA card in place of the engine UI.
  const chromeVisible = phase === 'ready' || phase === 'live';
  const live = phase === 'live';

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
      {/* Session banner: only meaningful while the engine is actually
          running. In 'ready' the chrome is up but the engine isn't,
          so there's nothing to be "degraded" about yet. */}
      {live ? (
        <SessionBanner
          health={sessionHealth}
          onRetry={onRetry}
          onDisconnect={onDisconnect}
        />
      ) : null}
      {/* No second OAuth surface here on purpose: the user authenticates
          once at the app's entry gate (`App.tsx` → `RemoteSignInScreen`)
          and that is the single source of truth. In LAN mode we silently
          push the gate token to the daemon (see `auth.seed.*` flow in
          the parent); if that ever fails the failure surfaces in the
          Hugging Face menu item, never as a duplicate full-screen
          login. The `isAuthenticated` flag below only gates the Apps
          tab, which legitimately needs the daemon-held token. */}
      {live && daemonVersion?.outdated ? (
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
        {/* The engine is mounted from 'engine' phase onward in both
            modes (the DC IS the daemon transport). 'ready' covers it
            with the CTA below so the user always lands in the same
            post-connect chrome regardless of how they got here. */}
        <ConversePanel
          peerId={peerId}
          peerIdResolved={peerIdResolved}
          remountKey={conversationRemountKey}
          onAppStateChange={onAppStateChange}
          onStuck={onEngineStuck}
          busyLabel={conversationBusyLabel}
          errorMessage={conversationErrorMessage}
        />
        {phase === 'ready' ? (
          <Stack
            alignItems="center"
            justifyContent="center"
            spacing={1.5}
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 3,
              bgcolor: theme.palette.background.paper,
              px: 3,
              textAlign: 'center',
            }}
          >
            <HandshakeReadyView
              robotName={robotName}
              onStart={onStartConversation}
            />
          </Stack>
        ) : null}
        {live ? (
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
      {chromeVisible && showAppsTab ? (
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

