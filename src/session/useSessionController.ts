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
  extractInstallId,
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
import { parseWifiStatus } from '../wifi/useWifiSetup';

const logger = createLogger('session');

// ─── Step labels (mirror of RobotSessionScreen) ───────────────────────

export const LOCAL_STEP_LABELS = ['Bluetooth', 'Network', 'Daemon', 'Wake up'] as const;
/**
 * REMOTE flow user-facing labels.
 *
 * The internal FSM still has 4 steps (0..3) including a leading
 * "Hugging Face" step that resolves the peer id from central.
 * However the app-level auth gate runs *before* `RobotSessionScreen`
 * mounts, so by the time we render here that step is always already
 * resolved (or we never landed at all). Showing it as a stepper
 * entry was pure visual noise: a green tick that flashed for less
 * than a frame, plus a redundant identity datapoint (HF username)
 * that's already in the top bar.
 *
 * We therefore drop it from the displayed list and project the FSM's
 * internal index onto the displayed list via `displayActiveStep`
 * below: FSM 0,1,2,3 → displayed 0,0,1,2 (the Hugging Face step
 * collapses onto "WebRTC" so a peer-id failure still paints the
 * first visible row red, even if the row's label doesn't match the
 * exact failure - the title/body of the failure card carry the
 * specific message).
 */
export const REMOTE_STEP_LABELS = ['WebRTC', 'Daemon', 'Wake up'] as const;

/**
 * Project the FSM's internal `activeStep` onto the displayed step
 * list. Identity for LOCAL (the displayed list is identical to the
 * FSM's). For REMOTE, the leading "Hugging Face" step is hidden
 * (always-green by construction, see `REMOTE_STEP_LABELS` doc), so
 * we shift everything left by one and clamp at 0.
 */
export function displayActiveStep(isLocal: boolean, fsmStep: number): number {
  if (isLocal) return fsmStep;
  return Math.max(0, fsmStep - 1);
}

/**
 * Compute a one-token enrichment for a completed step, or `null`
 * when no observable provides a useful value yet.
 *
 * This is intentionally conservative: an empty string from
 * `endpoint`, a null `bleNetworkIp`, or an in-flight `daemonVersion`
 * all collapse to `null` so the stepper falls back to the bare
 * label. We never speculate.
 *
 * Enrichment table:
 *
 *   LOCAL flow (`isLocal === true`)
 *     0 Bluetooth   → no enrichment (the BLE address is too long
 *                     and not user-meaningful)
 *     1 Network     → BLE IP if read, else `endpoint` (loopback
 *                     host for the localhost target)
 *     2 Daemon      → daemon version (e.g. `v1.7.4`)
 *     3 Wake up     → no enrichment
 *
 *   REMOTE flow (`isLocal === false`)
 *     0 Hugging Face → username (whose account we're authenticated
 *                       as), useful when the user has multiple HF
 *                       accounts
 *     1 WebRTC      → no enrichment (the ICE candidate type is too
 *                     technical for the connection screen)
 *     2 Daemon      → daemon version
 *     3 Wake up     → no enrichment
 */
function stepDetailFor(args: {
  index: number;
  isLocal: boolean;
  bleNetworkIp: string | null;
  bleNetworkSsid: string | null;
  endpoint: string;
  daemonVersion: DaemonVersionInfo | null;
  engineState: AppState | null;
}): string | null {
  const {
    index,
    isLocal,
    bleNetworkIp,
    bleNetworkSsid,
    endpoint,
    daemonVersion,
    engineState,
  } = args;
  const versionDetail = daemonVersion?.version ? `v${daemonVersion.version}` : null;

  if (isLocal) {
    // LOCAL: 0 Bluetooth · 1 Network · 2 Daemon · 3 Wake up.
    if (index === 1) {
      // BLE IP first (the LAN one), fallback to localhost endpoint.
      // When we also know the SSID (BLE-discovered Wi-Fi robot), join
      // them with " · " so the user can sanity-check both at a
      // glance: "192.168.1.42 · MyWifi". The localhost / USB path
      // never has an SSID (loopback isn't on Wi-Fi), so the join
      // collapses to just the host string in that case.
      const host =
        bleNetworkIp && bleNetworkIp.length > 0
          ? bleNetworkIp
          : endpoint && endpoint.length > 0
            ? endpoint
            : null;
      if (!host) return null;
      if (bleNetworkSsid && bleNetworkSsid.length > 0) {
        return `${host} · ${bleNetworkSsid}`;
      }
      return host;
    }
    if (index === 2) return versionDetail;
    if (index === 3) return engineSubLabel(engineState);
    return null;
  }

  // REMOTE: 0 WebRTC · 1 Daemon · 2 Wake up.
  // (The original FSM-side "Hugging Face" step is collapsed away
  //  here, see `REMOTE_STEP_LABELS` doc.)
  if (index === 1) return versionDetail;
  if (index === 2) return engineSubLabel(engineState);
  return null;
}

/**
 * Map the conversation engine's `AppState` to a short, user-meaningful
 * caption shown under the "Wake up" step while it's in flight.
 * Returns `null` for states that don't fit the bring-up window
 * (post-ready states like `listening` shouldn't appear here because
 * the FSM has already advanced past `'engine'` by then; we still
 * guard defensively).
 *
 * The wake-up step is the longest visible step (2-5 s typical), and
 * keeping the user informed about *which* phase we're in mid-step
 * removes the "is the spinner stuck?" worry. The captions stay short
 * (≤ 18 chars) so they don't break the row layout on a 4-inch screen.
 */
function engineSubLabel(state: AppState | null): string | null {
  if (state === null) return null;
  switch (state) {
    case 'connecting':
    case 'auto-selecting':
      return 'opening channel';
    case 'connected':
    case 'authenticated':
      return 'channel ready';
    case 'starting':
      return 'starting engine';
    default:
      return null;
  }
}

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
 * Minimum time each teardown sub-step stays in the `'active'` state
 * before the runner allows itself to advance to the next one. Some
 * steps (engine teardown, BLE disconnect) typically resolve in tens
 * of milliseconds; without this floor the user would never see them
 * land - the row would flash from active to completed and disappear
 * before the eye registered it. 600 ms is short enough that the
 * teardown still feels snappy, long enough that a checkmark
 * landing is perceptible.
 */
const LEAVING_STEP_MIN_MS = 600;

/**
 * Linger after the very last sub-step has finished so the user sees
 * every row settled as `completed` (✓) before the screen unmounts.
 * Without this the last row would still read as "active" the moment
 * the screen pops, breaking the perceived "everything wrapped up
 * cleanly" signal.
 */
const LEAVING_DONE_LINGER_MS = 350;

/**
 * Promise-friendly setTimeout. Used by the teardown runner to enforce
 * `LEAVING_STEP_MIN_MS` and `LEAVING_DONE_LINGER_MS` without
 * splattering setTimeout callbacks through the async flow.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * Run an async operation and guarantee that at least `minMs` have
 * elapsed before this helper resolves, regardless of how fast the
 * operation itself completes. Slow operations pay no extra penalty
 * (we only pad the *remaining* time after they finish).
 *
 * The pad runs in a `finally` block so it applies to both success
 * and rejection paths: if a teardown step fails fast, we still want
 * the user to see its row in the active state long enough to
 * register that something was attempted there.
 */
async function runWithMinDuration<T>(
  op: Promise<T>,
  minMs: number,
): Promise<T> {
  const start = Date.now();
  try {
    return await op;
  } finally {
    const elapsed = Date.now() - start;
    if (elapsed < minMs) {
      await sleep(minMs - elapsed);
    }
  }
}

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

/**
 * Hard ceiling on the engine bring-up phase. If we sit in 'engine'
 * (= "Waking up…") for this long without `tunnel_ready` firing, we
 * surface a wake-up failure so the user gets a Retry CTA rather than
 * an indefinite stuck overlay. Sized above the engine's own 15 s
 * `startSession` guard plus a few seconds for the daemon probe to
 * land on the new DC, so the happy slow path never trips it.
 */
const ENGINE_BRINGUP_TIMEOUT_MS = 25_000;

// ─── Public types ─────────────────────────────────────────────────────

/**
 * Sub-steps of the `'leaving'` phase, surfaced so `LeavingView` can
 * tell the user what is actually happening during teardown instead
 * of just spinning. Order mirrors the runner's sequential `await`s:
 *
 *   pending             → before the runner kicks (fleeting; usually
 *                         only visible if the screen un-mounts on
 *                         the same React tick the FSM transitioned).
 *   putting-to-sleep    → flushing the motion store, i.e. waiting
 *                         for `goto_sleep` + disable_motors to land
 *                         through the daemon's WebRTC HTTP proxy.
 *   closing-channel     → engine `endSession` + WebRTC DC close.
 *   releasing-bluetooth → BLE GATT disconnect; LAN-only step.
 *   done                → handed off to `onBack`; rendered briefly
 *                         before the screen un-mounts.
 *
 * Bound consumers should treat unknown values as `'pending'` to stay
 * forwards-compatible with future steps (e.g. central peer cleanup).
 */
export type LeavingStep =
  | 'pending'
  | 'putting-to-sleep'
  | 'closing-channel'
  | 'releasing-bluetooth'
  | 'done';

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
  /** Transport badge displayed in the top bar. Constant for the screen. */
  transport: 'BLE' | 'USB' | 'HF';
  /** First 6 hex chars of the daemon's install_id, or `null` when not yet
   * decoded (legacy daemons, BLE row before TLV parse, …). */
  installIdSuffix: string | null;
  /** LAN IP for local/localhost targets, empty for remote (the badge
   * already says "HF"). Updates live as `bleNetworkIp` resolves. */
  endpoint: string;
  /** Phase-aware status word for the top bar. "Reading status…" during
   * handshake, "awake"/"sleeping" once the robot is up. */
  statusText: string;
  /** Live motor state for the inline dot. Null during handshake/engine
   * so the top bar suppresses the dot until it'd be meaningful. */
  motorState: 'awake' | 'sleeping' | 'unknown' | null;
  /**
   * Base step labels: stable strings, identical for every render.
   * Used by the controller's own status-text formatter so it can
   * append "…" without doubling up enrichment.
   */
  stepLabels: readonly string[];
  /**
   * Per-step observed datapoint, parallel array to `stepLabels`.
   * `null` when the corresponding observable hasn't landed yet, a
   * short string when it has (e.g. `192.168.1.42`, `v1.7.4`).
   * The handshake step list renders this as a small secondary line
   * under the step's primary label.
   */
  stepDetails: readonly (string | null)[];
  /**
   * `state.activeStep` projected onto `stepLabels` (which can have a
   * different cardinality than the FSM's internal index, e.g. REMOTE
   * collapses 4 FSM steps into 3 visible ones). Use this for any
   * stepper rendering or "current step" maths; reach for
   * `state.activeStep` only when you actually need the FSM-internal
   * value.
   */
  displayedActiveStep: number;

  /**
   * Current sub-step of the teardown sequence. Only meaningful while
   * `state.phase === 'leaving'`; outside that, always `'pending'`.
   * Drives the granular caption rendered by `LeavingView`.
   */
  leavingStep: LeavingStep;

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
  onEngineErrorMessage: (message: string | null) => void;

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
    sendCommand,
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
  // Connected Wi-Fi SSID, fetched once via `WIFI_STATUS` over BLE
  // right after the LAN IP lands. Surfaced in the connection stepper
  // as a sanity-check secondary line under the IP. Null when:
  //   - target is `localhost` (USB tray, no Wi-Fi to read);
  //   - target is `remote` (no BLE link to query);
  //   - daemon doesn't speak `WIFI_STATUS` (legacy firmware, swallowed
  //     into null);
  //   - the read hasn't completed yet (transient null on first paint).
  const [bleNetworkSsid, setBleNetworkSsid] = useState<string | null>(null);

  // ── Engine state observed via ConversePanel ────────────────────────
  const [engineState, setEngineStateRaw] = useState<AppState | null>(null);
  const onEngineStateChange = useCallback((s: AppState): void => {
    setEngineStateRaw(s);
  }, []);

  // ── Last engine error message (bubbled from the panel) ─────────────
  // Captured for the wake-up failure surface: when the engine errors
  // under the bring-up overlay (typical: WebRTC startSession timeout
  // when STUN can't traverse a symmetric NAT) the message is the most
  // useful "what happened" line we can show the user.
  const [engineErrorMessage, setEngineErrorMessage] = useState<string | null>(
    null,
  );
  const onEngineErrorMessage = useCallback((m: string | null): void => {
    setEngineErrorMessage(m);
    if (m) logger.warn('engine.error.bubbled', { message: m });
  }, []);

  // Granular teardown progress (see `LeavingStep`). Updated by the
  // teardown runner below as each sequential `await` starts; consumed
  // by `LeavingView` for the per-step caption + step indicator.
  const [leavingStep, setLeavingStep] = useState<LeavingStep>('pending');

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
        return {
          kind: 'local',
          deviceName: target.device.name,
          // Strongest identity we have on a BLE-discovered robot:
          // the daemon's persistent install_id prefix (TLV 0x01).
          // Central propagates the same value as `meta.install_id`,
          // so the resolver can do an exact prefix match instead of
          // falling back to the (dangerous) "single robot in fleet"
          // / "first robot" heuristics.
          installIdPrefix: target.device.installIdPrefix,
          // Volatile but useful as a backup strong identifier when
          // the daemon was on central at the time of the advert
          // (TLV 0x02). Resolver tries `installIdPrefix` first and
          // falls through to this when needed.
          centralPeerIdPrefix: target.device.centralPeerIdPrefix,
        };
      case 'localhost':
        // Prefer the daemon's own ``central_peer_id`` (returned by
        // ``GET /api/daemon/identity``) over a name-based central
        // lookup: when the user owns several robots that share the
        // default ``reachy_mini`` name (the very common "tray on
        // Mac + WiFi robot" pairing) the name resolver picks
        // ``robots[0]`` which is consistently the *other* robot,
        // hijacking the WebRTC session away from the tray daemon
        // the user actually tapped. ``central_peer_id`` is only
        // ``null`` while the relay is offline (no token, no
        // network) - in that case we fall back to the legacy name
        // probe rather than wedge the screen.
        if (target.centralPeerId) {
          return { kind: 'direct', peerId: target.centralPeerId };
        }
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
      // Structured log so the mode+ip are readable in the plain-text
      // log dump (the `console.info` upstream prints an Object that
      // collapses to "[object Object]" once copied out of the
      // inspector). Keep them at INF level - they're invaluable when
      // diagnosing "why didn't Wi-Fi setup show up?" reports.
      logger.info('handshake.network_status', {
        mode: ns.mode ?? null,
        ip: ns.ip ?? null,
        hostname: ns.hostname ?? null,
        port: ns.port ?? null,
      });
      // We need an IP *and* the robot must be on a real network.
      //
      // ``mode === 'hotspot'`` means the daemon is broadcasting its own
      // AP because no known Wi-Fi was reachable: the robot has IP
      // 10.42.0.1 on wlan0 but no upstream internet, so it can't
      // register on HF central and the WebRTC handshake will hang
      // forever (`webrtc.proxy fetch.no_dc` loop). The right UX in
      // that case is to skip the engine bring-up and offer the Wi-Fi
      // setup screen straight away - same as the no-IP path below.
      //
      // We also treat ``ip === '10.42.0.1'`` as hotspot: that's the
      // address the daemon's NetworkManager gives the robot's own
      // wlan0 when it falls back to its local AP. Some firmwares
      // surface ``mode='wifi'`` here (the daemon sees a Wi-Fi
      // interface, technically true), so the mode field alone is
      // not authoritative - the IP literal is.
      const isHotspot =
        ns.mode === 'hotspot' || ns.ip === '10.42.0.1';
      if (!ns.ip || isHotspot) {
        dispatch({
          kind: 'handshake.failed',
          error: {
            failedAt: 1,
            title: 'Robot is not on a Wi-Fi yet',
            body: isHotspot
              ? "It's broadcasting its own hotspot. Let's connect it to a network."
              : "Let's set one up.",
            detail: `NETWORK_STATUS: mode=${ns.mode || 'unknown'}, ip=${ns.ip ?? 'null'}`,
            offerWifiSetup: true,
          },
        });
        return;
      }

      // Step 2 ('Daemon' / 'WebRTC'): hand off to the engine.
      setBleNetworkIp(ns.ip);

      // Fire-and-forget: read the connected SSID over BLE so the
      // stepper can show "192.168.1.42 · MyWifi" as a sanity check.
      // We deliberately don't await: the engine bring-up doesn't
      // depend on it, and a slow daemon shouldn't delay the wake-up.
      // Errors are swallowed (legacy daemons may not speak
      // `WIFI_STATUS`; transient BLE errors are not worth surfacing
      // here either - the rest of the connection works fine without
      // the SSID).
      void (async () => {
        try {
          const raw = await sendCommand('WIFI_STATUS');
          if (cancelled) return;
          const parsed = parseWifiStatus(raw);
          if (parsed?.connected) setBleNetworkSsid(parsed.connected);
        } catch {
          // Silently ignored - SSID is purely informational.
        }
      })();

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
    logger.info('engine.tunnel_ready', {
      engine_state: engineState,
      daemon_probe: daemonProbe.kind,
    });
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

  // ── Engine bring-up watchdogs (engine phase only) ──────────────────
  // Two failure surfaces, both safety nets for the case where the
  // wake-up runner above never gets to fire because `tunnelReady`
  // never holds (DC stuck negotiating, daemon probe never lands).
  // Without these the user sat on "Waking up…" indefinitely whenever
  // WebRTC bringup hit a NAT failure.
  //
  //   1. Engine reported a fatal error (state === 'error' OR a non-
  //      empty `engineErrorMessage` came up before the engine self-
  //      reset to a non-error state). Surface it immediately.
  //   2. Hard timeout: still in 'engine' after `ENGINE_BRINGUP_TIMEOUT_MS`
  //      with no tunnelReady transition. Surface a generic failure so
  //      the user can retry.
  useEffect(() => {
    if (state.phase !== 'engine') return;
    if (engineState !== 'error' && !engineErrorMessage) return;
    const message =
      engineErrorMessage ??
      'Connection to the robot failed during bring-up. Tap retry to try again.';
    logger.warn('engine.bringup.error', { message, engine_state: engineState });
    dispatch({
      kind: 'engine.wake_failed',
      error: {
        failedAt: Date.now(),
        title: 'Could not reach the robot',
        body: message,
        detail: `engineState=${engineState ?? 'null'}`,
        offerWifiSetup: false,
      },
    });
  }, [state.phase, engineState, engineErrorMessage, dispatch]);

  useEffect(() => {
    if (state.phase !== 'engine') return;
    const timer = window.setTimeout(() => {
      logger.warn('engine.bringup.timeout', {
        engine_state: engineState,
        daemon_probe: daemonProbe.kind,
        active_step: state.activeStep,
      });
      dispatch({
        kind: 'engine.wake_failed',
        error: {
          failedAt: Date.now(),
          title: 'Robot took too long to respond',
          body: 'The robot did not come online in time. Tap retry to try again.',
          detail: `engineState=${engineState ?? 'null'} daemonProbe=${daemonProbe.kind}`,
          offerWifiSetup: false,
        },
      });
    }, ENGINE_BRINGUP_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
    // We intentionally only re-arm on (phase, retryEpoch). engineState
    // and daemonProbe.kind churn doesn't reset the clock - a flapping
    // probe shouldn't extend an unhealthy bring-up indefinitely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.retryEpoch, dispatch]);

  // Clear the bubbled engine error on retry / phase exit so the next
  // attempt starts from a clean slate (otherwise a leftover string
  // from the last try would re-trip the surface effect above before
  // the new engine has a chance to run).
  useEffect(() => {
    if (state.phase !== 'engine') {
      if (engineErrorMessage !== null) setEngineErrorMessage(null);
    }
  }, [state.phase, state.retryEpoch, engineErrorMessage]);

  // ── Teardown runner ('leaving' phase) ──────────────────────────────
  //
  // `leavingStep` mirrors the runner's progress so `LeavingView` can
  // surface what is actually happening (instead of a single
  // featureless "Disconnecting…" spinner). Values map 1:1 to the
  // sequential `await`s below; `'done'` is set just before `onBack`
  // fires so the caption can flicker to "Done" before the screen
  // unmounts (helpful on slow phones where unmount itself takes a
  // beat). Reset to `'pending'` on phase exit (defensive: the screen
  // should unmount before that happens, but a re-entry into another
  // session must start from a clean state).
  useEffect(() => {
    if (state.phase !== 'leaving') {
      if (leavingStep !== 'pending') setLeavingStep('pending');
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      setLeavingStep('done');
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
      //
      // Every step is padded with `runWithMinDuration` so that even
      // an instant resolve (typical for `flushEngineLifecycle` and
      // `disconnectDevice`) stays in the active state long enough
      // to be perceptible. Without this floor the user sees the
      // last two rows flash from active to checkmark-and-gone in a
      // single frame, which reads as "did anything actually
      // happen?".
      setLeavingStep('putting-to-sleep');
      try {
        await runWithMinDuration(flushMotionPending(), LEAVING_STEP_MIN_MS);
      } catch {
        // best-effort
      }
      setLeavingStep('closing-channel');
      try {
        await runWithMinDuration(
          flushEngineLifecycle(),
          LEAVING_STEP_MIN_MS,
        );
      } catch {
        // best-effort
      }
      if (isLocal && connectedAddress) {
        setLeavingStep('releasing-bluetooth');
        try {
          await runWithMinDuration(
            disconnectDevice(),
            LEAVING_STEP_MIN_MS,
          );
        } catch {
          // best-effort
        }
      }
      // All sub-steps reported - linger briefly so every row in the
      // checklist has a moment to read as completed (✓) before the
      // screen pops. `finish()` is the one that actually un-mounts
      // us, so the linger has to live BEFORE it.
      setLeavingStep('done');
      await sleep(LEAVING_DONE_LINGER_MS);
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
  // dedicated subscriber that pushes into the summary directly, and
  // mirror the `current` value into local React state so the top-bar
  // can render the live motor dot without subscribing itself.
  const [motorCurrent, setMotorCurrent] = useState<
    'awake' | 'sleeping' | 'unknown'
  >(() => getMotionState().current);
  useEffect(() => {
    setMotorCurrent(getMotionState().current);
    return subscribeMotion((s) => {
      summary.set('motion', {
        desired: s.desired,
        current: s.current,
        lastOutcome: s.lastOutcome,
      });
      setMotorCurrent(s.current);
    });
  }, []);

  const onEngineTransport = useCallback(
    (kind: ConversationTransportKind): void => {
      summary.set('transport', kind);
    },
    [],
  );

  // ── Top-bar identity / endpoint / status (replaces single-line subtitle) ─
  // The top bar now surfaces 4 small datapoints instead of one freeform
  // string: a transport badge ([BLE]/[USB]/[HF]), the install_id
  // suffix (#xxxxxx), the live endpoint (LAN IP / loopback host), and a
  // phase-aware status word. Each is derived independently here so the
  // view stays a thin renderer.
  const transport: 'BLE' | 'USB' | 'HF' = (() => {
    switch (target.kind) {
      case 'local':
        return 'BLE';
      case 'localhost':
        return 'USB';
      case 'remote':
        return 'HF';
    }
  })();

  const installIdSuffix = useMemo<string | null>(() => {
    switch (target.kind) {
      case 'local':
        return target.device.installIdPrefix?.slice(0, 6) ?? null;
      case 'localhost':
        return target.installId?.slice(0, 6) ?? null;
      case 'remote': {
        const id = extractInstallId(target.robot);
        return id ? id.slice(0, 6) : null;
      }
    }
  }, [target]);

  const endpoint = useMemo<string>(() => {
    switch (target.kind) {
      case 'local':
        // Empty until the BLE handshake reads NETWORK_STATUS — the
        // top bar then degrades gracefully to "[BLE] · status".
        return bleNetworkIp ?? '';
      case 'localhost':
        return target.host;
      case 'remote':
        // The badge ("HF") already carries the "this is over the
        // internet" signal; another line of "Hugging Face" would be
        // pure redundancy on a 4-inch screen.
        return '';
    }
  }, [target, bleNetworkIp]);

  // Motor-dot rendering is gated on phase: only meaningful once the
  // robot's actually in a session. During handshake/engine the dot
  // would just be a grey blob — we hide it instead.
  const motorState: 'awake' | 'sleeping' | 'unknown' | null =
    state.phase === 'ready' || state.phase === 'live' ? motorCurrent : null;

  // ── Per-step observed datapoint ─────────────────────────────────────
  //
  // Parallel array to `stepLabels`. Each cell carries a short
  // human-readable observation we made about that step (e.g.
  // `192.168.1.42` once we know the LAN IP, `v1.7.4` once the daemon
  // has answered with its version). The view renders this as a
  // secondary line under the step's primary label.
  //
  // Step indices match the LOCAL_STEP_LABELS / REMOTE_STEP_LABELS
  // arrays:
  //
  //   LOCAL  : 0 Bluetooth · 1 Network · 2 Daemon · 3 Wake up
  //   REMOTE : 0 Hugging Face · 1 WebRTC · 2 Daemon · 3 Wake up
  //
  // We surface the detail as soon as the observable lands, even on
  // pending steps. Rationale: showing `192.168.1.42` while we're
  // still on step 1 ("Network…") proves we have the IP in hand and
  // that the spinner isn't a UI lie. The view is in charge of
  // styling completed vs. active vs. pending.
  //
  // Never invent data: if we don't have a value yet, the cell is
  // `null` and the view falls back to no secondary line.
  const stepDetails = useMemo<readonly (string | null)[]>(() => {
    return stepLabels.map((_label, index) =>
      stepDetailFor({
        index,
        isLocal,
        bleNetworkIp,
        bleNetworkSsid,
        endpoint,
        daemonVersion,
        engineState,
      }),
    );
  }, [
    stepLabels,
    isLocal,
    bleNetworkIp,
    bleNetworkSsid,
    endpoint,
    daemonVersion,
    engineState,
  ]);

  // FSM-internal `activeStep` projected onto the displayed step list.
  // Identity for LOCAL, shift-by-one for REMOTE so the dropped
  // "Hugging Face" step doesn't leave a phantom slot in the
  // displayed activeStep math (see `displayActiveStep` doc).
  const displayedActiveStep = displayActiveStep(isLocal, state.activeStep);

  const statusText = useMemo<string>(() => {
    if (state.phase === 'leaving') return 'Disconnecting…';
    if (state.phase === 'ready' || state.phase === 'live') {
      if (motorCurrent === 'awake') return 'awake';
      if (motorCurrent === 'sleeping') return 'sleeping';
      return 'starting';
    }
    if (state.error) return state.error.title;
    // Handshake / engine: take whichever step we just transitioned to.
    // We use `displayedActiveStep` (not `state.activeStep`) so REMOTE
    // doesn't say "Hugging Face…" for an invisible-to-the-user step
    // that the auth gate already passed - it instead reads the first
    // visible label ("WebRTC…").
    const label =
      stepLabels[displayedActiveStep] ?? stepLabels[stepLabels.length - 1];
    return `${label}…`;
  }, [state, motorCurrent, stepLabels, displayedActiveStep]);

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
    transport,
    installIdSuffix,
    endpoint,
    statusText,
    motorState,
    stepLabels,
    stepDetails,
    displayedActiveStep,
    leavingStep,
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
    onEngineErrorMessage,
    retry,
    back,
    startConversation,
    needsWifi,
    // expose isAuthenticated through auth + computed convenience flag
    // is handled in views via `controller.auth.isAuthenticated` for LAN
    // and a constant `true` for remote; controller never needs it.
  } satisfies SessionController;
}
