/**
 * useSessionController - the brain of the post-discovery screen.
 *
 * Why this hook exists
 * ────────────────────
 * `RobotSessionScreen.tsx` used to be a 1000-line "god component"
 * orchestrating BLE handshake, peer-id resolution, daemon probe,
 * conversation engine lifecycle, motion store, HF auth bootstrap,
 * relay heal, teardown, and rendering all at once. Splitting that
 * into one render component + one logic hook means:
 *
 *   - The screen is a pure renderer that consumes the hook's return
 *     value. It can be split into `HandshakeView` / `ReadyView` /
 *     `LeavingView` / `ConversationView` without dragging the
 *     business logic around.
 *   - The logic gets a single, named, testable surface. New states
 *     and effects land here, not in JSX.
 *   - The FSM (`sessionFsm.ts`) is the only mutation surface;
 *     transitions become explicit and illegal events are caught.
 *   - `connectionSummary` gets wired in one place, so the structured
 *     `connection` log line is fed by the same source the UI sees.
 *
 * What this hook owns
 * ───────────────────
 * - The FSM state (phase, activeStep, error, retry/remount epochs).
 * - The session-scoped trace id.
 * - `bleNetworkIp`, `daemonVersion`, `engineState`, `autoSeedAttempted`.
 * - The auto-seed of the daemon's HF token (LAN side-channel).
 * - The handshake runner (BLE pair / NETWORK_STATUS / peer-id check).
 * - The wake-up gate (setDesiredState + flushPending → success/failure).
 * - The relay-heal watchdog plumbing.
 * - The graceful teardown when the user taps Back.
 * - Pushing every observable into `connectionSummary`.
 *
 * What this hook does NOT own
 * ───────────────────────────
 * - The `RTCPeerConnection`: still owned by the ReachyMini SDK,
 *   we only observe it via `useReachySdk` + `ConversePanel`.
 * - The conversation pipeline (antennas/OpenAI/wobbler): the engine
 *   itself owns that, gated by `convoActive` (== `phase === 'live'`).
 * - The actual rendering: that's the screen / view components.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  extractRobotId,
  extractRobotName,
} from '../auth/fetchRobotsFromCentral';
import { useHfAuth, type UseHfAuthResult } from '../auth/useHfAuth';
import {
  useResolvedPeerId,
  type PeerIdTarget,
} from '../auth/useResolvedPeerId';
import {
  useBleSession,
  type NetworkStatus,
} from '../ble/useBleSession';
import type { AppState } from '../conversation/conversation-engine';
import type { ConversationTransportKind } from '../conversation/conversation-engine';
import { flushEngineLifecycle } from '../conversation/ConversePanel';
import { useReachySdk } from '../conversation/useReachySdk';
import { daemonFetch } from '../daemon/daemonFetch';
import {
  probeDaemonVersion,
  type DaemonVersionInfo,
} from '../daemon/daemonProbeVersion';
import {
  flushPending as flushMotionPending,
  getMotionState,
  resetMotionSession,
  setDesiredState,
  subscribeMotion,
} from '../daemon/robotMotion';
import { useDaemonRelayHealing } from '../daemon/useDaemonRelayHealing';
import {
  useDaemonStatus,
  type DaemonProbeState,
} from '../daemon/useDaemonStatus';
import { createLogger, newTraceId, setTraceId } from '../logger';
import * as summary from '../observability/connectionSummary';
import { createRobotClient } from '../robot-client';
import type { RobotClient } from '../robot-client/types';

import {
  describeIllegalTransition,
  INITIAL_SESSION_STATE,
  reduceSession,
  type ConnectionTarget,
  type HandshakeError,
  type SessionEvent,
  type SessionFsmState,
} from './sessionFsm';
import { useSessionHealth } from './useSessionHealth';
import type { SessionHealth } from './types';

const logger = createLogger('session');

// ─── Step labels (mirror of RobotSessionScreen) ───────────────────────

export const LOCAL_STEP_LABELS = ['Bluetooth', 'Network', 'Daemon', 'Wake up'] as const;
export const REMOTE_STEP_LABELS = [
  'Hugging Face',
  'WebRTC',
  'Daemon',
  'Wake up',
] as const;

/**
 * Watchdog ceiling for the leaving phase. Sized to fit the worst-case
 * teardown:
 *
 *   - up to ~2.5 s of an in-flight `wake_up.json` trajectory the user
 *     interrupts by tapping Disconnect mid wake-up (the motion store
 *     coalesces-queues `sleeping` behind it),
 *   - the full ~2 s of `goto_sleep.json`,
 *   - engine `endSession` + DC close on top of that.
 *
 * Anything longer feels like the back button is stuck; anything
 * shorter clips `goto_sleep` and leaves the robot frozen mid-trajectory.
 */
const TEARDOWN_TIMEOUT_MS = 5_500;

/**
 * Engine `AppState` values that mean the WebRTC tunnel is still
 * being negotiated. The wake-up gate keeps the daemon proxy idle
 * until the engine has left this set, otherwise the first wake POST
 * races with the connection setup and we waste a 4 s timeout.
 */
const TRANSIENT_ENGINE_STATES: ReadonlySet<AppState> = new Set([
  'connecting',
  'auto-selecting',
  'starting',
]);

// ─── Public types ─────────────────────────────────────────────────────

export interface UseSessionControllerOptions {
  target: ConnectionTarget;
  /** HF username from the app gate; used in the remote-mode subtitle. */
  username: string | null;
  /** HF access token from the app gate; used in LAN to seed the daemon. */
  hfToken: string | null;
  /** Called once the screen has finished tearing down (post-leaving). */
  onBack: () => void;
  /** Local-only: robot has no Wi-Fi yet, navigate to setup. */
  onNeedsWifi?: () => void;
}

export interface SessionController {
  // FSM (immutable snapshot via useReducer)
  state: SessionFsmState;

  // Target metadata (constant for the lifetime of the screen)
  target: ConnectionTarget;
  isLocal: boolean;
  displayName: string;
  subtitle: string;
  stepLabels: readonly string[];

  // Live observables consumed by views
  robotClient: RobotClient;
  engineState: AppState | null;
  peerId: string | null;
  peerIdResolved: boolean;
  daemonProbe: DaemonProbeState;
  daemonVersion: DaemonVersionInfo | null;
  sessionHealth: SessionHealth;
  bleNetworkIp: string | null;
  auth: UseHfAuthResult;

  // Conversation panel inputs
  convoActive: boolean;
  conversationBusyLabel: string | null;
  conversationErrorMessage: string | null;

  // Engine event sinks (passed to ConversePanel)
  onEngineStateChange: (s: AppState) => void;
  onEngineStuck: () => Promise<void>;
  onEngineTransport: (kind: ConversationTransportKind) => void;

  // User commands
  retry: () => void;
  back: () => void;
  startConversation: () => void;
  /** Local-only: route to the Wi-Fi setup screen. No-op when not LAN. */
  needsWifi: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────

export function useSessionController(
  opts: UseSessionControllerOptions,
): SessionController {
  const { target, username, hfToken, onBack, onNeedsWifi } = opts;
  // `isLocal` is the historical "transport is LAN-HTTP, not central
  // WebRTC" predicate. We extend it to cover the new `localhost`
  // variant since the auto-seed, HF auth probe, and daemon-direct
  // calls all behave the same way for both: they need a known LAN
  // host and bypass the WebRTC `http_proxy`. The two LAN flavours
  // diverge only at handshake time (BLE pair vs no-op).
  const isLocal = target.kind === 'local' || target.kind === 'localhost';
  const stepLabels = isLocal ? LOCAL_STEP_LABELS : REMOTE_STEP_LABELS;
  const displayName = (() => {
    switch (target.kind) {
      case 'local':
        return target.device.name;
      case 'localhost':
        return target.robotName;
      case 'remote':
        return extractRobotName(target.robot);
    }
  })();
  // Stable id for logs / connection summary. Each variant has a different
  // notion of "this is robot X" so we centralise the resolution here.
  const targetId = (() => {
    switch (target.kind) {
      case 'local':
        return target.device.address;
      case 'localhost':
        return `localhost:${target.host}`;
      case 'remote':
        return extractRobotId(target.robot);
    }
  })();

  // ── FSM ────────────────────────────────────────────────────────────
  // We wrap the reducer so every (prev, event, next) triple is logged.
  // Illegal events stay no-ops in the reducer itself; the wrapper just
  // surfaces them so they show up in the dev console.
  const [state, rawDispatch] = useReducer(
    (prev: SessionFsmState, event: SessionEvent): SessionFsmState => {
      const next = reduceSession(prev, event);
      const ignored = describeIllegalTransition(prev, next, event);
      if (ignored) {
        logger.warn('fsm.event_ignored', { detail: ignored });
      } else if (prev.phase !== next.phase) {
        logger.info('phase.transition', { from: prev.phase, to: next.phase });
      }
      return next;
    },
    INITIAL_SESSION_STATE,
  );

  // Stable dispatch ref so callbacks captured in long-lived closures
  // (motion subscriber, transport listener) always see the latest
  // reducer without being in their effect dependency arrays.
  const dispatchRef = useRef(rawDispatch);
  dispatchRef.current = rawDispatch;
  const dispatch = useCallback(
    (event: SessionEvent) => dispatchRef.current(event),
    [],
  );

  // ── Mount-time setup ───────────────────────────────────────────────
  // Trace id, motion-store reset, and connectionSummary reset all run
  // exactly once per (target identity) so a fresh session never
  // inherits the previous one's snapshot.
  useEffect(() => {
    const trace = newTraceId();
    setTraceId(trace);
    summary.reset();
    summary.update({
      traceId: trace,
      target: {
        kind: target.kind,
        id: targetId,
        name: displayName,
      },
    });
    logger.info('mount', {
      trace,
      target_kind: target.kind,
      target_id: targetId,
    });
    // Motion store is module-singleton (it has to outlive any single
    // React tree to coalesce mount/unmount bursts), so without this
    // reset the next session would inherit `current === 'awake'`
    // from the previous robot and skip the new wake_up entirely.
    resetMotionSession();
    return () => {
      logger.info('unmount');
      setTraceId(null);
      summary.reset();
    };
  }, [target, displayName, targetId]);

  // ── BLE session (LAN only) ─────────────────────────────────────────
  const {
    connectToDevice,
    disconnectDevice,
    readNetworkStatus,
    connectedAddress,
  } = useBleSession();

  // ── LAN host IP for direct daemon HTTP calls ───────────────────────
  // Only used for narrow side-channel HTTP calls that legitimately
  // need a direct LAN socket: the daemon-mediated HF OAuth flow
  // (`useHfAuth`, redirect URI lives on `reachy-mini.local:8000`)
  // and the auto-seed of `/api/hf-auth/save-token`.
  //
  // For BLE (`local`) we discover this IP during the handshake by
  // reading `NETWORK_STATUS`. For `localhost` we know it up front
  // (the discovery probe found it on `127.0.0.1`). For remote the
  // value stays null and the consumers degrade to no-ops.
  const [bleNetworkIp, setBleNetworkIp] = useState<string | null>(
    target.kind === 'localhost' ? target.host : null,
  );

  // ── Engine state observed via ConversePanel ────────────────────────
  const [engineState, setEngineStateRaw] = useState<AppState | null>(null);
  const onEngineStateChange = useCallback((s: AppState): void => {
    setEngineStateRaw(s);
  }, []);

  // ── Robot client (single WebRTC transport) ─────────────────────────
  // Built once at mount. The DC underneath gets installed by
  // `useReachySdk`/`ConversePanel` later; until then `client.fetch()`
  // returns synthetic 0-status responses, which the daemon-status pill
  // and other consumers already render as "connecting…". This is on
  // purpose: a single client instance + a single transport means the
  // rest of the screen is genuinely target-agnostic.
  const robotClient = useMemo(() => createRobotClient(), []);

  // ── Daemon status pill + step 3 advance ────────────────────────────
  const daemonProbe = useDaemonStatus(robotClient, {
    pollMs: state.phase === 'live' ? 5_000 : 1_500,
  });

  // ── Eager SDK load ─────────────────────────────────────────────────
  // The ReachyMini JS SDK is a global singleton (`useReachySdk` is
  // backed by a module-level loader). Calling the hook here kicks off
  // the CDN fetch on mount, in parallel with the BLE / WebRTC
  // handshake, so by the time the user taps "Start conversation" the
  // SDK is already in memory and `ConversePanel` mounts the engine
  // synchronously.
  useReachySdk();

  // ── Peer id resolution (transport-agnostic) ────────────────────────
  // For `localhost` we feed the daemon-reported robot name into the
  // `local` peer-id resolver: central indexes producers by name, so
  // once the robot has been named (and the gate has lifted server-
  // side) it appears on central with that label and the resolver
  // finds it. For an unnamed localhost robot the peer id stays
  // unresolved until naming is done - matching the WebRTC reality
  // (the daemon hasn't registered yet either).
  const peerIdTarget = useMemo<PeerIdTarget>(() => {
    switch (target.kind) {
      case 'local':
        return { kind: 'local', deviceName: target.device.name };
      case 'localhost':
        return { kind: 'local', deviceName: target.robotName };
      case 'remote':
        return { kind: 'remote', robot: target.robot };
    }
  }, [target]);
  const {
    peerId: resolvedPeerId,
    resolved: peerIdResolved,
    refresh: refreshPeerId,
  } = useResolvedPeerId(peerIdTarget, hfToken);

  // ── Lazy daemon-relay heal ─────────────────────────────────────────
  const {
    healing: relayHealing,
    lastHealth: relayHealth,
    triggerHeal: triggerRelayHeal,
  } = useDaemonRelayHealing(robotClient);

  const onEngineStuck = useCallback(async (): Promise<void> => {
    logger.info('engine.stuck.detected');
    const result = await triggerRelayHeal();
    logger.info('engine.stuck.heal', {
      outcome: result.outcome,
      status: result.health.status,
    });
    // We only force a fresh engine on `healed`: that is the only
    // outcome where the daemon ↔ central handshake actually changed,
    // so the cached SSE / peer id we hold is now stale. `noop` /
    // `failed` / `unreachable` are handled by the panel's own
    // watchdog without forcing a remount.
    if (result.outcome === 'healed') {
      await refreshPeerId();
      dispatch({ kind: 'engine.relay_healed' });
    }
  }, [triggerRelayHeal, refreshPeerId, dispatch]);

  // ── Hard-stop hint when relay is unrecoverable client-side ─────────
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

  // ── One-shot daemon version probe ──────────────────────────────────
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

  // ── Session health (folded daemon + engine) ────────────────────────
  const sessionHealth = useSessionHealth(daemonProbe, engineState);

  // ── HF auth (LAN side-channel) ─────────────────────────────────────
  const auth = useHfAuth(isLocal ? bleNetworkIp : null);
  const isAuthenticated = isLocal ? auth.isAuthenticated : true;

  // ── Auto-seed daemon HF token (LAN only) ───────────────────────────
  // The user already authenticated at the app gate, so showing a
  // second OAuth surface for the LAN daemon would be silly. Push our
  // gate token to the daemon the first time we land here authenticated
  // app-side but NOT daemon-side. If the daemon rejects it (revoked,
  // wrong scope, …) we log the failure and surface a sign-in entry
  // in the top-bar menu; we don't take over the screen with a
  // duplicate full-page login.
  const [autoSeedAttempted, setAutoSeedAttempted] = useState(false);
  const {
    isLoading: authIsLoadingProbe,
    isAuthenticated: authIsAuthenticatedDaemon,
    refresh: authRefresh,
  } = auth;
  useEffect(() => {
    if (!isLocal) return;
    if (autoSeedAttempted) return;
    if (authIsLoadingProbe) return;
    if (authIsAuthenticatedDaemon) {
      logger.info('auth.seed.skipped', {
        reason: 'daemon_already_authenticated',
      });
      setAutoSeedAttempted(true);
      return;
    }
    if (!hfToken) return;
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

  // ── Handshake runner ───────────────────────────────────────────────
  // Runs on entry to handshake (either at mount or after retry). On
  // success dispatches `handshake.bridged`; on failure, .failed.
  useEffect(() => {
    if (state.phase !== 'handshake') return;
    let cancelled = false;

    if (target.kind === 'remote') {
      const peerId = extractRobotId(target.robot);
      if (!peerId) {
        dispatch({
          kind: 'handshake.failed',
          error: {
            failedAt: 0,
            title: 'No peer id for this robot',
            body: 'Hugging Face central did not return a usable peer id. Try refreshing the list.',
            detail: JSON.stringify(target.robot, null, 2),
            offerWifiSetup: false,
          },
        });
        return;
      }
      // Step 1 (Hugging Face) is done as soon as we land here.
      dispatch({ kind: 'handshake.step', step: 1 });
      dispatch({ kind: 'handshake.bridged' });
      return;
    }

    if (target.kind === 'localhost') {
      // No BLE pair, no Wi-Fi probe: the daemon was already answering
      // on the loopback host at discovery time, and the LAN IP is
      // already in `bleNetworkIp`. We tick step 0 ('Bluetooth' label
      // is reused for parity with the BLE flow's stepper but means
      // "found the daemon" here) and step 1 ('Network') in lock step
      // and immediately bridge to the engine phase.
      dispatch({ kind: 'handshake.step', step: 1 });
      dispatch({ kind: 'handshake.bridged' });
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
          dispatch({
            kind: 'handshake.failed',
            error: {
              failedAt: 0,
              title: "Couldn't open the Bluetooth session",
              body: 'The robot rejected or timed out the connection attempt.',
              detail: null,
              offerWifiSetup: false,
            },
          });
          return;
        }
      }
      if (cancelled) return;
      dispatch({ kind: 'handshake.step', step: 1 });

      // Step 1: read network status over BLE.
      let ns: NetworkStatus;
      try {
        ns = await readNetworkStatus();
      } catch (err) {
        if (cancelled) return;
        dispatch({
          kind: 'handshake.failed',
          error: {
            failedAt: 1,
            title: "Couldn't read the robot's status",
            body: 'Try again, or restart the robot if the issue persists.',
            detail: err instanceof Error ? err.message : String(err),
            offerWifiSetup: false,
          },
        });
        return;
      }
      if (cancelled) return;
      if (!ns.ip) {
        dispatch({
          kind: 'handshake.failed',
          error: {
            failedAt: 1,
            title: 'Robot is not on a Wi-Fi yet',
            body: "Let's set one up.",
            detail: `NETWORK_STATUS: mode=${ns.mode || 'unknown'}, ip=null`,
            offerWifiSetup: true,
          },
        });
        return;
      }

      // Step 2 ('Daemon' / 'WebRTC'): hand off to the engine.
      setBleNetworkIp(ns.ip);
      dispatch({ kind: 'handshake.bridged' });
    })();

    return () => {
      cancelled = true;
    };
    // We deliberately key off the FSM's `retryEpoch` (rather than only
    // `state.phase`) so a Retry tap from inside 'handshake' re-runs
    // even though the phase didn't change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.retryEpoch, target]);

  // ── Engine substep tick (engine left transient + daemon probe ok) ──
  // Drives the activeStep advance from 2 → 3 within the engine phase.
  // We dispatch `engine.tunnel_ready` once both conditions hold; the
  // FSM dedups so a flickering daemon probe doesn't bounce activeStep.
  useEffect(() => {
    if (state.phase !== 'engine') return;
    const tunnelReady =
      daemonProbe.kind === 'ok' &&
      engineState !== null &&
      !TRANSIENT_ENGINE_STATES.has(engineState);
    if (!tunnelReady) return;
    dispatch({ kind: 'engine.tunnel_ready' });
  }, [state.phase, daemonProbe.kind, engineState, dispatch]);

  // ── Wake-up sequence (gates the final step) ────────────────────────
  // Same trigger as the substep tick above; we keep the two effects
  // separate because the wake-up runner has its own cancel scope and
  // can outlive a probe flap.
  useEffect(() => {
    if (state.phase !== 'engine') return;
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
        // best-effort
      }
      if (cancelled) return;
      const outcome = getMotionState().lastOutcome;
      if (outcome === 'completed' || outcome === 'idle') {
        dispatch({
          kind: 'engine.wake_completed',
          totalSteps: stepLabels.length,
        });
        return;
      }
      // Surface a wake failure as a handshake error: this is the
      // only way the user can tell the difference between "robot
      // is silently stuck" (bus_stuck bug, where the daemon
      // reports `move_completed` but the robot never moved) and
      // "robot is awake and waiting for me to start a convo".
      logger.warn('wake.surface_error', { outcome });
      dispatch({
        kind: 'engine.wake_failed',
        error: {
          failedAt: Date.now(),
          title: 'Robot did not wake up',
          body:
            outcome === 'bus_stuck'
              ? "The robot's motors didn't follow the wake-up trajectory. Tap retry to recycle the motor bus and try again."
              : outcome === 'transport_down'
                ? 'The connection to the robot dropped during wake-up. Tap retry to reconnect.'
                : 'Wake-up did not complete cleanly. Tap retry to start over.',
          detail: `lastOutcome=${outcome}`,
          offerWifiSetup: false,
        },
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    state.phase,
    daemonProbe.kind,
    engineState,
    robotClient,
    stepLabels.length,
    dispatch,
  ]);

  // ── Teardown runner ('leaving' phase) ──────────────────────────────
  useEffect(() => {
    if (state.phase !== 'leaving') return;
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
      // Sequential to avoid stepping on each other:
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
      settled = true;
      window.clearTimeout(timeoutHandle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // ── connectionSummary wiring ───────────────────────────────────────
  // Each effect feeds one section so changes are greppable in the log.
  useEffect(() => {
    summary.update({ phase: state.phase, step: state.activeStep });
  }, [state.phase, state.activeStep]);

  useEffect(() => {
    summary.set('engine', engineState);
  }, [engineState]);

  useEffect(() => {
    summary.set('daemon', daemonProbe.kind);
  }, [daemonProbe.kind]);

  useEffect(() => {
    summary.set('peerId', {
      value: resolvedPeerId,
      resolved: peerIdResolved,
    });
  }, [resolvedPeerId, peerIdResolved]);

  useEffect(() => {
    summary.set('health', sessionHealth.status);
  }, [sessionHealth.status]);

  // Motion store changes can't be captured with React state alone
  // (the store is a singleton with its own pub/sub). We bridge via a
  // dedicated subscriber that pushes into the summary directly.
  useEffect(() => {
    return subscribeMotion((s) => {
      summary.set('motion', {
        desired: s.desired,
        current: s.current,
        lastOutcome: s.lastOutcome,
      });
    });
  }, []);

  const onEngineTransport = useCallback(
    (kind: ConversationTransportKind): void => {
      summary.set('transport', kind);
    },
    [],
  );

  // ── Subtitle ───────────────────────────────────────────────────────
  const subtitle = useMemo(() => {
    if (target.kind === 'localhost') {
      // The IP itself is the most informative label here ('127.0.0.1'
      // tells the user "this is the daemon on this Mac" without us
      // needing a separate copy line).
      return target.host;
    }
    if (target.kind === 'local') {
      if (bleNetworkIp) return bleNetworkIp;
      if (target.device.name) return target.device.name;
      return 'Bluetooth';
    }
    return username ? `Signed in as ${username}` : 'Over the internet';
  }, [target, bleNetworkIp, username]);

  // ── Convo gate forwarded to ConversePanel ──────────────────────────
  const convoActive = state.phase === 'live';

  // ── Commands ───────────────────────────────────────────────────────
  const retry = useCallback(
    () => dispatch({ kind: 'retry.requested' }),
    [dispatch],
  );
  const back = useCallback(
    () => dispatch({ kind: 'leave.requested' }),
    [dispatch],
  );
  const startConversation = useCallback(
    () => dispatch({ kind: 'live.requested' }),
    [dispatch],
  );
  const needsWifi = useCallback(() => {
    if (!isLocal) return;
    onNeedsWifi?.();
  }, [isLocal, onNeedsWifi]);

  // ── Public surface ─────────────────────────────────────────────────
  return {
    state,
    target,
    isLocal,
    displayName,
    subtitle,
    stepLabels,
    robotClient,
    engineState,
    peerId: resolvedPeerId,
    peerIdResolved,
    daemonProbe,
    daemonVersion,
    sessionHealth,
    bleNetworkIp,
    auth,
    convoActive,
    conversationBusyLabel,
    conversationErrorMessage,
    onEngineStateChange,
    onEngineStuck,
    onEngineTransport,
    retry,
    back,
    startConversation,
    needsWifi,
    // expose isAuthenticated through auth + computed convenience flag
    // is handled in views via `controller.auth.isAuthenticated` for LAN
    // and a constant `true` for remote; controller never needs it.
  } satisfies SessionController;
}
