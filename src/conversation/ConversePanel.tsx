/**
 * React wrapper around the conversation engine.
 *
 * Renders the same static markup the original Space ships (index.html)
 * inside a scoped `.converse-root` container, then hands the root
 * element over to `mountConversation()` which wires up every DOM event,
 * WebRTC peer connection and audio analyser exactly like `main.ts` did.
 *
 * React deliberately owns only:
 *   - Loading the ReachyMini SDK once
 *   - Seeding `sessionStorage.hf_token` from the daemon-mediated HF auth
 *   - A pre-flight cross-check of the daemon ↔ HF central handshake
 *     (and auto-heal if a "zombie relay" desync is detected)
 *   - Mounting / unmounting the engine when the panel is shown / hidden
 *   - A watchdog that surfaces a retryable error if the engine gets
 *     stuck in a transient state past a reasonable budget
 *
 * Everything conversational (state machine, audio, motion agents) lives
 * in the engine so the port stays a mechanical copy of the Space app.
 */
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchHfSession } from '../auth/fetchHfToken';
import {
  autoHealRelay,
  checkDaemonHealth,
  type DaemonHealth,
  isHealthyForMount,
} from '../daemon/daemonHealthCheck';
import { fetchRobotPeerId } from '../daemon/fetchRobotPeerId';

import {
  mountConversation,
  type AppState,
  type ConversationEngineHandle,
} from './conversation-engine';
import { seedHfToken, useReachySdk } from './useReachySdk';
import './conversation.css';

// Module-level serialisation of engine lifecycles.
//
// Why not a closure-local `aborted` flag?
// ───────────────────────────────────────
// We already tried a per-effect abort flag + microtask deferral. It's
// not enough in practice:
//
//   - React.StrictMode's double-invoke is documented as synchronous,
//     but the actual flush depends on the scheduler. We see traffic
//     on HF central during both mounts, which means the abort flag
//     fails to race the inner `mountConversation` call at least some
//     of the time (likely when the two effect runs land in separate
//     scheduler tasks so the microtask drains between them).
//   - `mountConversation` kicks off `robot.connect()` immediately,
//     which opens a long-lived SSE to the central. Two of them in
//     flight have the central multiplex both sessions' offers/ICE
//     into the same client stream. The second `_pc` then receives
//     the first session's ICE candidates before its own offer has
//     been processed, throwing "remote description was null" on
//     every stray candidate.
//
// The module-level lock below guarantees at most ONE engine is
// reachable from `handleRef` at any time, and that a new engine is
// only built AFTER the previous one's `unmount()` promise has
// resolved. This keeps central's session book clean: session N-1 is
// fully torn down before session N even starts connecting.
//
// It lives outside the component on purpose: React can create
// several instances of ConversePanel during StrictMode double-
// invoke, and a component-scoped ref wouldn't serialise across
// those instances.
let engineLifecyclePromise: Promise<void> = Promise.resolve();
let engineMountCounter = 0;

/**
 * Wait until every queued mount/unmount has settled. Useful when a
 * parent screen wants to leave the converse view *after* the engine's
 * teardown has had a chance to reach central with `endSession`, so the
 * producer is freed instantly instead of waiting for central's own
 * 15 s session timeout.
 *
 * Resolves on the next microtask if the queue is empty. Never rejects:
 * teardown errors are swallowed inside the chain so a previous failure
 * can't block subsequent waiters.
 */
export function flushEngineLifecycle(): Promise<void> {
  return engineLifecyclePromise.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * How long we let the engine spend in any transient "still making
 * progress" state before deciding it's stuck and surfacing a retry
 * button. Tuned by hand:
 *
 *   - Good LAN path (preselected robot id): `signed-out` → `starting`
 *     → `listening` takes 2-4 s including central's SSE handshake.
 *   - Pathological-but-recoverable (central busy, retry cycle): up
 *     to 12 s before either settling into `listening` or timing out
 *     via the engine's own 15 s startSession guard.
 *
 * 20 s gives us enough margin above the engine's internal timeout
 * (+5 s) that a healthy-but-slow path never trips the watchdog, while
 * still feeling snappy when the robot is actually wedged. Any state
 * in `TRANSIENT_STATES` that's held for longer means something is
 * broken in a way the engine can't recover from on its own.
 */
const WATCHDOG_TIMEOUT_MS = 20_000;

/**
 * States that are supposed to be *on the way to* a steady conversation.
 * Staying in any of them past WATCHDOG_TIMEOUT_MS is our signal to
 * surface a retry affordance. `error` is intentionally omitted - the
 * engine already shows its own message in that case and the user has
 * the orb's retry gesture.
 */
const TRANSIENT_STATES = new Set<AppState>([
  'connecting',
  'connected',
  'auto-selecting',
  'starting',
]);

interface ConversePanelProps {
  /** Daemon host (IP) the Reachy SDK should reach for WebRTC signaling. */
  daemonHost: string | null;
  /** `true` when the HF daemon flow has completed. Gates engine mount. */
  isAuthenticated: boolean;
  /**
   * Remote mode: phone has no LAN line of sight to the daemon. We
   * skip the daemon health check and the token/peer-id fetches; both
   * the HF token (already in `sessionStorage.hf_token`) and the
   * peerId (passed as `remotePeerId`) come from the parent screen.
   *
   * Defaults to false so the existing LAN call sites keep their
   * behaviour without change. Toggled to `true` by
   * `RobotSessionScreen` whenever the discovery view picked a
   * remote (HF central) robot rather than a BLE one.
   */
  remoteMode?: boolean;
  /**
   * Pre-resolved central peerId to call `startSession()` with when
   * `remoteMode` is true. Required in remote mode; ignored otherwise
   * because the LAN flow derives it from the daemon.
   */
  remotePeerId?: string | null;
  /**
   * Optional observer that fires on every engine state-machine
   * transition. Used by the unified connection screen to drive its
   * own progress stepper: it watches for the engine to leave the
   * transient `connecting`/`auto-selecting`/`starting` set and flips
   * the UI from "still connecting…" to "live conversation".
   *
   * Pure side-channel - the panel itself doesn't change behaviour
   * based on whether anyone is listening. We forward the same
   * `onStateChange` to `mountConversation`'s engine option so the
   * watchdog the panel already runs internally and the parent see
   * the exact same transitions, in order, no buffering.
   */
  onAppStateChange?: (state: AppState) => void;
}

export function ConversePanel({
  daemonHost,
  isAuthenticated,
  remoteMode = false,
  remotePeerId = null,
  onAppStateChange,
}: ConversePanelProps): React.ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ConversationEngineHandle | null>(null);
  const { isReady, isLoading, error: sdkError } = useReachySdk();
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenReady, setTokenReady] = useState(false);
  // Peer id the daemon says this robot is registered as on HF central.
  // We treat it as an optional fast-path hint: when present, the
  // engine skips the "Waiting for Reachy" wait on robotsChanged and
  // calls startSession(id) directly; when null (endpoint failed,
  // relay not connected, …) the engine falls back to the classic
  // tap-to-connect + auto-select flow. The mount effect waits until
  // this fetch has resolved (either way) so the option isn't seen
  // as `undefined` on the first render.
  const [preselectedRobotId, setPreselectedRobotId] = useState<string | null>(null);
  const [preselectionResolved, setPreselectionResolved] = useState(false);

  // Daemon ↔ central health. While this is still probing we hold
  // back the engine mount (we don't want to start a doomed session
  // against a zombie relay). Once resolved it stays on the component
  // until the user takes a retryable action; transitions are:
  //
  //   null (probing) → 'healthy' → engine mounts
  //                  ↘ 'zombie-relay' without heal endpoint
  //                     → surface "restart daemon on Reachy"
  //                  ↘ any other error status → retryable error UI
  const [healthStatus, setHealthStatus] = useState<DaemonHealth | null>(null);
  const [healing, setHealing] = useState(false);

  // Watchdog state. When the engine is mounted we observe every
  // AppState transition; if the engine lingers in a TRANSIENT_STATE
  // past WATCHDOG_TIMEOUT_MS we flip `watchdogTripped` and surface a
  // retry UI. A successful transition out of the transient set
  // (e.g. into `listening`) clears the watchdog.
  const [watchdogTripped, setWatchdogTripped] = useState(false);

  // Bumped by the Retry button to force effects to re-run end-to-end
  // (fresh health probe + fresh token + fresh engine).
  const [retryKey, setRetryKey] = useState(0);

  const onRetry = useCallback(() => {
    setWatchdogTripped(false);
    setTokenError(null);
    setTokenReady(false);
    setPreselectedRobotId(null);
    setPreselectionResolved(false);
    setHealthStatus(null);
    setRetryKey((k) => k + 1);
  }, []);

  // Keep the parent's state observer in a ref so the engine's
  // long-lived onStateChange closure always sees the latest callback
  // identity. The mount effect captures `appStateRef` once; the
  // parent is free to change `onAppStateChange` between renders
  // without triggering a re-mount.
  const appStateRef = useRef<((s: AppState) => void) | null>(null);
  appStateRef.current = onAppStateChange ?? null;

  // Step 0: daemon health pre-flight. Runs before token/peer-id so we
  // can detect a zombie relay and ask the daemon to self-heal BEFORE
  // we spend time fetching things that depend on central seeing us
  // as a registered robot. A healthy check here is the single gating
  // signal for everything downstream.
  //
  // Remote mode skips this entirely: the phone has no LAN line of
  // sight to the daemon, so probing it would always say `unreachable`
  // and lock the engine out. Instead we synthesise a `healthy`
  // status so the downstream gates open, and we trust central to
  // surface a real error (robot offline, peerId stale, etc.) once
  // the SDK tries to reach it.
  useEffect(() => {
    let cancelled = false;

    if (!isAuthenticated) {
      setHealthStatus(null);
      return;
    }
    if (remoteMode) {
      setHealthStatus({ status: 'healthy' });
      return;
    }
    if (!daemonHost) {
      setHealthStatus({ status: 'unreachable' });
      return;
    }

    void (async () => {
      const initial = await checkDaemonHealth(daemonHost);
      if (cancelled) return;

      // Any relay state that isn't fully healthy at the moment the
      // user wants to talk is worth a force-reconnect attempt:
      //
      //   - `zombie-relay`        classic desync (relay thinks it's
      //                           up, central lists robots: []).
      //   - `relay-disconnected`  the case observed in the field
      //                           where the daemon boots before
      //                           central is reachable OR the
      //                           `connecting` state never settles
      //                           because setPeerStatus is stuck on
      //                           an old SSE. A force reconnect
      //                           drops and restarts the cycle.
      //
      // We deliberately skip heal for `no-token` / `unreachable` /
      // `healthy` because nothing on the daemon's side would change.
      const shouldHeal =
        initial.status === 'zombie-relay' ||
        initial.status === 'relay-disconnected';

      if (shouldHeal) {
        console.warn(
          `[ConversePanel] ${initial.status} detected, attempting auto-heal`,
        );
        setHealing(true);
        const healed = await autoHealRelay(daemonHost);
        setHealing(false);
        if (cancelled) return;
        setHealthStatus(healed);
        return;
      }

      setHealthStatus(initial);
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, daemonHost, remoteMode, retryKey]);

  // Step 1: once the daemon is healthy, pull the HF token + the
  // robot's HF-central peer id from the daemon. We run the two
  // fetches in parallel because they're both blocking for the mount
  // (we won't mount the engine until the token is staged; we won't
  // benefit from the fast-path until the id is resolved, either to a
  // string or to a definitive null). Failures are handled
  // independently: a missing peer id just degrades to the classic
  // wait-on-robotsChanged flow, while a missing token is a hard-stop
  // that surfaces a sign-in prompt.
  //
  // Remote mode short-circuits both fetches: the token is already in
  // `sessionStorage.hf_token` (seeded by `useRemoteHfToken`), and
  // the peerId comes from the user's earlier robot pick on
  // `RemoteScreen`, passed in via `remotePeerId`.
  useEffect(() => {
    let cancelled = false;
    setTokenError(null);
    setTokenReady(false);
    setPreselectedRobotId(null);
    setPreselectionResolved(false);

    if (!isAuthenticated) {
      // Don't blow away the token in remote mode: it lives in
      // localStorage independent of `isAuthenticated` (which mirrors
      // the LAN/daemon flow only).
      if (!remoteMode) seedHfToken(null);
      return;
    }
    if (remoteMode) {
      // The token was seeded into sessionStorage by the parent
      // (useRemoteHfToken's mount effect). Verify it's there before
      // claiming "ready" so the engine doesn't start without a
      // bearer and then fall back to HF central's anonymous-not-
      // allowed path.
      const hasToken =
        typeof sessionStorage !== 'undefined' &&
        !!sessionStorage.getItem('hf_token');
      if (!hasToken) {
        setTokenError('Sign-in lost. Re-enter your Hugging Face token.');
        return;
      }
      setTokenReady(true);
      setPreselectedRobotId(remotePeerId);
      setPreselectionResolved(true);
      return;
    }
    if (!daemonHost) {
      setTokenError('No daemon host available.');
      return;
    }
    // Gate on the pre-flight: no point fetching token/id if the
    // relay is sick - the engine would stall at "Waiting for Reachy".
    if (!healthStatus || !isHealthyForMount(healthStatus)) return;

    void (async () => {
      try {
        const session = await fetchHfSession(daemonHost);
        if (cancelled) return;
        if (!session) {
          setTokenError('Sign-in lost. Please sign in again from the menu.');
          return;
        }
        seedHfToken(session);
        setTokenReady(true);
      } catch (err) {
        if (cancelled) return;
        setTokenError(err instanceof Error ? err.message : 'Failed to fetch HF token');
      }
    })();

    void (async () => {
      const id = await fetchRobotPeerId(daemonHost);
      if (cancelled) return;
      setPreselectedRobotId(id);
      setPreselectionResolved(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, daemonHost, healthStatus, remoteMode, remotePeerId, retryKey]);

  // Step 2: mount the engine once SDK + token + peer-id probe are
  // all ready. See the big "Module-level serialisation" comment at
  // the top of this file for why we queue the mount/unmount pair on
  // a module-global promise chain instead of running them directly.
  useEffect(() => {
    if (!isReady) return;
    if (!tokenReady) return;
    if (!preselectionResolved) return;
    if (!healthStatus || !isHealthyForMount(healthStatus)) return;
    const root = rootRef.current;
    if (!root) return;

    // Closure-local state: the token identifies this specific effect
    // run and lets the cleanup reject its OWN scheduled mount if it
    // fires before the mount actually happened. `localHandle` holds
    // the engine handle for this effect run once mounted.
    const token = ++engineMountCounter;
    let aborted = false;
    let localHandle: ConversationEngineHandle | null = null;

    // Per-effect watchdog handle. Re-armed on every TRANSIENT_STATE
    // entry, cleared on entry to any non-transient state. We keep it
    // scoped to the effect so an unmount (cleanup below) always
    // drops the pending timeout without needing a ref-level flag.
    let watchdogTimer: number | null = null;
    const armWatchdog = (): void => {
      if (watchdogTimer !== null) return;
      watchdogTimer = window.setTimeout(() => {
        watchdogTimer = null;
        console.warn(
          `[ConversePanel] watchdog trip (engine stuck > ${WATCHDOG_TIMEOUT_MS}ms)`,
        );
        setWatchdogTripped(true);
      }, WATCHDOG_TIMEOUT_MS);
    };
    const disarmWatchdog = (): void => {
      if (watchdogTimer !== null) {
        window.clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    };

    // Chain BOTH the mount and the teardown behind any previous
    // lifecycle op. This way if StrictMode fires mount₂ while
    // mount₁'s unmount is still settling, mount₂ waits for it to
    // fully resolve before building a new engine.
    engineLifecyclePromise = engineLifecyclePromise.then(async () => {
      if (aborted) {
        // Effect was already cleaned up before we got to run. Skip
        // the mount entirely; no unmount to do either.
        return;
      }
      try {
        console.info(`[ConversePanel] mounting engine (token=${token})`);
        const handle = mountConversation(root, {
          preselectedRobotId,
          onStateChange: (state) => {
            // Watchdog transitions are a simple edge-detector: we
            // arm on entry to a transient state, disarm otherwise.
            // Re-arming while already armed is a no-op so
            // back-to-back transients (connecting → connected →
            // auto-selecting) don't reset the clock and hide a
            // genuine stall.
            if (TRANSIENT_STATES.has(state)) {
              armWatchdog();
            } else {
              disarmWatchdog();
              // Entering a non-transient healthy state is implicit
              // recovery; clear any prior "stuck" flag so the UI
              // returns to the engine view without a retry click.
              if (state !== 'error') {
                setWatchdogTripped(false);
              }
            }
            // Fan out to the parent observer (unified screen's
            // stepper) AFTER the watchdog so internal bookkeeping
            // never blocks on a third-party callback. Errors thrown
            // by the parent are swallowed here so a bad subscriber
            // can't wedge the engine itself.
            const cb = appStateRef.current;
            if (cb) {
              try {
                cb(state);
              } catch (err) {
                console.warn('[ConversePanel] onAppStateChange threw:', err);
              }
            }
          },
        });
        localHandle = handle;
        handleRef.current = handle;
      } catch (err) {
        console.error('[ConversePanel] mountConversation failed:', err);
      }
    });

    return () => {
      aborted = true;
      disarmWatchdog();
      // Queue the unmount AFTER the mount promise so we never try
      // to tear down an engine that hasn't finished being built.
      engineLifecyclePromise = engineLifecyclePromise.then(async () => {
        const handle = localHandle;
        localHandle = null;
        if (handle && handleRef.current === handle) {
          handleRef.current = null;
        }
        if (!handle) return;
        console.info(`[ConversePanel] unmounting engine (token=${token})`);
        try {
          await handle.unmount();
        } catch (err) {
          console.warn('[ConversePanel] unmount error:', err);
        }
      });
    };
  }, [isReady, tokenReady, preselectionResolved, preselectedRobotId, healthStatus]);

  // ─── Render gating ────────────────────────────────────────────────────
  //
  // The display priority from most to least specific:
  //   1. Fatal SDK / token error (nothing we can do until sign-in)
  //   2. Watchdog tripped (engine mounted but stuck)
  //   3. Unrecoverable health status (zombie without heal, unreachable)
  //   4. Healing / probing spinner
  //   5. Engine view (normal path)
  //
  // We precompute each variant up-front rather than cramming ternaries
  // into the JSX, because the branching tells the whole story and we
  // want it to read linearly.

  const fatalMessage = sdkError?.message ?? tokenError;

  // "Zombie without heal" means the daemon doesn't ship the
  // /refresh-relay endpoint AND is in the bad state. The user has to
  // restart it manually; we surface the instruction verbatim.
  const healthRequiresRestart =
    healthStatus?.status === 'zombie-relay' &&
    healthStatus.refreshEndpointAvailable === false;

  // Any other non-healthy terminal state shows a generic retry CTA.
  const healthError =
    healthStatus != null &&
    !isHealthyForMount(healthStatus) &&
    !healthRequiresRestart;

  const showHealingSpinner = healing;

  const showLoadingSpinner =
    !fatalMessage &&
    !watchdogTripped &&
    !healthRequiresRestart &&
    !healthError &&
    !showHealingSpinner &&
    (isLoading ||
      (isAuthenticated &&
        (healthStatus === null || !tokenReady || !preselectionResolved)));

  const engineVisible =
    isReady &&
    tokenReady &&
    preselectionResolved &&
    !fatalMessage &&
    !watchdogTripped &&
    !healthRequiresRestart &&
    !healthError &&
    !!healthStatus &&
    isHealthyForMount(healthStatus);

  return (
    <Box sx={{ position: 'relative', flex: 1, minHeight: 0, width: '100%' }}>
      {fatalMessage ? (
        <Box sx={centeredFallbackSx}>
          <Typography variant="body2" color="error" sx={{ textAlign: 'center', px: 3 }}>
            {fatalMessage}
          </Typography>
        </Box>
      ) : null}

      {!fatalMessage && watchdogTripped ? (
        <Box sx={centeredFallbackSx}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            Robot unresponsive
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ textAlign: 'center', px: 3, mb: 3, maxWidth: 320 }}
          >
            The conversation engine has been waiting for too long. The robot
            may be busy with another session, or its relay lost sync with
            the HuggingFace server.
          </Typography>
          <Button variant="contained" onClick={onRetry} sx={retryBtnSx}>
            Retry
          </Button>
        </Box>
      ) : null}

      {!fatalMessage && !watchdogTripped && healthRequiresRestart ? (
        <Box sx={centeredFallbackSx}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            Restart needed on Reachy
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ textAlign: 'center', px: 3, mb: 3, maxWidth: 320 }}
          >
            The robot's HuggingFace relay is out of sync and this version of
            the daemon cannot self-heal. SSH into the robot and run
            {' '}
            <code>sudo systemctl restart reachy-mini-daemon</code>, then retry.
          </Typography>
          <Button variant="contained" onClick={onRetry} sx={retryBtnSx}>
            I've restarted. Retry.
          </Button>
        </Box>
      ) : null}

      {!fatalMessage && !watchdogTripped && !healthRequiresRestart && healthError ? (
        <Box sx={centeredFallbackSx}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            Cannot reach the robot
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ textAlign: 'center', px: 3, mb: 3, maxWidth: 320 }}
          >
            {healthStatusBlurb(healthStatus!)}
          </Typography>
          <Button variant="contained" onClick={onRetry} sx={retryBtnSx}>
            Retry
          </Button>
        </Box>
      ) : null}

      {showHealingSpinner ? (
        <Box sx={centeredFallbackSx}>
          <CircularProgress size={28} />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            Reconnecting robot to HuggingFace…
          </Typography>
        </Box>
      ) : null}

      {showLoadingSpinner ? (
        <Box sx={centeredFallbackSx}>
          <CircularProgress size={28} />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            Loading Reachy SDK…
          </Typography>
        </Box>
      ) : null}

      <div
        ref={rootRef}
        className="converse-root"
        style={{
          display: engineVisible ? 'grid' : 'none',
        }}
        dangerouslySetInnerHTML={{ __html: CONVERSE_MARKUP }}
      />
    </Box>
  );
}

/**
 * Short user-facing explanation of why we can't mount the engine.
 * Kept terse - the button next to it handles action; this is the
 * "why" one-liner.
 */
function healthStatusBlurb(h: DaemonHealth): string {
  switch (h.status) {
    case 'relay-disconnected':
      return 'The daemon has not reconnected to HuggingFace yet. Give it a few seconds and retry.';
    case 'no-token':
      return 'The robot is not signed in to HuggingFace. Sign in from the menu, then retry.';
    case 'unreachable':
      return 'Could not reach the robot daemon. Check it is powered on and on the same network.';
    case 'zombie-relay':
      // We only hit this branch when refreshEndpointAvailable !== false,
      // which means auto-heal ran, failed to unstick the state within
      // the budget, and we still want the user to try once more.
      return 'Auto-healing the robot relay did not recover. Try again, or restart the daemon on the robot.';
    default:
      return 'The robot is not ready. Please retry.';
  }
}

// Fallback overlays sit ON TOP of the embedded conversation root, so
// they need to fully mask whatever the engine has rendered behind
// them. Match the host MUI palette (paper + primary text) instead of
// the engine's old hard-coded dark background, so the overlay reads
// correctly in both light and dark themes (was previously a black
// rectangle in light mode - the very "app inside an app" feel the
// redesign is fixing).
const centeredFallbackSx = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  bgcolor: 'background.paper',
  color: 'text.primary',
  zIndex: 1,
} as const;

const retryBtnSx = {
  fontWeight: 600,
  textTransform: 'none',
  px: 3,
} as const;

/**
 * Static markup ported verbatim from
 * `reachy_mini_minimal_conversation/index.html`. Kept as a single
 * string so the diff with the Space app stays greppable and we can
 * re-sync in one place if the reference ever changes.
 */
const CONVERSE_MARKUP = /* html */ `
<header class="topbar">
  <div class="brand">
    <img class="brand-logo" src="/images/reachy-head.svg" alt="" draggable="false" />
    <span>Reachy Mini</span>
  </div>
  <div class="topbar-right">
    <span id="transport-pill" class="transport-pill hidden" title="Robot transport path" aria-live="polite">
      <span class="transport-dot" aria-hidden="true"></span>
      <span id="transport-label" class="transport-label"></span>
      <span id="transport-bitrate" class="transport-bitrate" aria-hidden="true"></span>
    </span>
    <span id="hf-user" class="hf-user hidden">
      <img id="hf-avatar" class="hf-avatar" alt="" aria-hidden="true" />
      <span id="hf-user-name" class="hf-user-name"></span>
    </span>
    <button id="settings-btn" class="icon-btn" title="Settings" aria-label="Settings">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .66.39 1.25 1 1.51H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </button>
  </div>
</header>

<main class="stage">
  <div class="orb-wrap">
    <button id="mic-btn" class="side-btn" type="button" aria-label="Mute" title="Mute" aria-hidden="true">
      <svg class="mic-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
      <svg class="mic-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M9 5a3 3 0 0 1 6 0v4"/><path d="M9 10v1a3 3 0 0 0 5.1 2.1"/><path d="M19 10a7 7 0 0 1-1.24 3.97"/><path d="M5 10a7 7 0 0 0 11 5.67"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
    </button>

    <button id="main-circle" class="circle state-connecting" type="button" aria-label="Start voice conversation">
      <span class="circle-glow" aria-hidden="true"></span>
      <span class="circle-ring" aria-hidden="true"></span>
      <span class="circle-ring-outer" aria-hidden="true"></span>
      <span class="circle-core">
        <span class="circle-indicator" aria-hidden="true">
          <svg class="ind ind-connect" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 1 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 1 0 7.07 7.07l1.71-1.71"/>
          </svg>
          <svg class="ind ind-mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" stroke="none"/>
            <path d="M5 10a7 7 0 0 0 14 0"/>
            <line x1="12" y1="19" x2="12" y2="22"/>
            <line x1="8" y1="22" x2="16" y2="22"/>
          </svg>
          <svg class="ind ind-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12" y2="16"/></svg>
          <span class="ind ind-spinner"></span>
          <span class="ind ind-thinking">
            <span class="dot"></span>
            <span class="dot"></span>
            <span class="dot"></span>
          </span>
          <span class="ind ind-bars">
            <span class="bar"></span>
            <span class="bar"></span>
            <span class="bar"></span>
            <span class="bar"></span>
            <span class="bar"></span>
          </span>
          <svg class="ind ind-voice" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 10v4a1 1 0 0 0 1 1h3l5 4V5L7 9H4a1 1 0 0 0-1 1z" fill="currentColor" stroke="none"/>
            <path class="wave wave-1" d="M16 8a5 5 0 0 1 0 8"/>
            <path class="wave wave-2" d="M19 5a9 9 0 0 1 0 14"/>
          </svg>
        </span>
      </span>
    </button>

    <button id="stop-btn" class="side-btn" type="button" aria-label="End" title="End" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
    </button>
  </div>

  <p id="circle-caption" class="circle-caption" role="status">Connecting</p>

  <div id="tool-toast" class="tool-toast" role="status" aria-live="polite" aria-hidden="true">
    <svg class="tool-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3"/>
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1l2.1-2.1M17 7l2.1-2.1"/>
    </svg>
    <span class="tool-toast-text"></span>
  </div>

</main>

<footer class="footer">
  <span>Reachy Mini · OpenAI Realtime</span>
</footer>

<dialog id="settings-modal" class="modal">
  <form method="dialog" class="modal-content">
    <header class="modal-header">
      <h2>Settings</h2>
      <button class="icon-btn" value="close" aria-label="Close">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </header>

    <div class="tabs" role="tablist" aria-label="Settings sections">
      <button type="button" class="tab active" role="tab" aria-selected="true" data-tab="access">Access</button>
      <button type="button" class="tab" role="tab" aria-selected="false" data-tab="conversation">Conversation</button>
    </div>

    <div class="tab-panels">
      <section class="tab-panel active" role="tabpanel" data-tab-panel="access">
        <label class="field">
          <span>OpenAI API key</span>
          <input id="openai-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-..." />
          <small>Stored locally on this device. Sent as Bearer token to OpenAI only.</small>
        </label>
        <label id="hf-client-id-field" class="field hidden">
          <span>Hugging Face OAuth client ID</span>
          <input id="hf-client-id" type="text" autocomplete="off" spellcheck="false" />
          <small>Required only on <code>localhost</code>.</small>
        </label>
      </section>

      <section class="tab-panel" role="tabpanel" data-tab-panel="conversation" hidden>
        <label class="field">
          <span>Instructions</span>
          <textarea id="openai-instructions" rows="5" placeholder="You are Reachy Mini, a friendly robot assistant..."></textarea>
          <small>System prompt sent to the model. Applied on next conversation start.</small>
        </label>
        <div class="field-row">
          <label class="field">
            <span>Voice</span>
            <select id="openai-voice">
              <option value="alloy">alloy</option>
              <option value="ash">ash</option>
              <option value="ballad">ballad</option>
              <option value="cedar" selected>cedar</option>
              <option value="coral">coral</option>
              <option value="echo">echo</option>
              <option value="marin">marin</option>
              <option value="sage">sage</option>
              <option value="shimmer">shimmer</option>
              <option value="verse">verse</option>
            </select>
          </label>
          <label class="field">
            <span>Model</span>
            <input id="openai-model" type="text" spellcheck="false" placeholder="gpt-realtime" />
          </label>
        </div>
        <div class="field">
          <button id="restart-conversation" type="button" class="btn primary wide" disabled>
            Restart conversation with these settings
          </button>
          <small id="restart-hint">Connect first, then come back here to apply live changes.</small>
        </div>
      </section>
    </div>

    <footer class="modal-footer">
      <button id="hf-logout" type="button" class="btn ghost">Sign out</button>
      <button id="settings-save" type="submit" class="btn primary" value="save">Save</button>
    </footer>
  </form>
</dialog>
`;
