/**
 * Slim React wrapper around the conversation engine.
 *
 * The panel itself is intentionally dumb:
 *   - it renders the static markup ported from the original Space
 *     (`reachy_mini_minimal_conversation/index.html`),
 *   - it mounts / unmounts `mountConversation()` over that markup
 *     when the inputs it needs from the parent are ready,
 *   - and it surfaces overlays for SDK errors, parent-driven busy
 *     states (e.g. "reconnecting after heal") and a watchdog-trip
 *     retry CTA.
 *
 * Everything else - HF token seeding, peer id resolution, daemon
 * relay health checks, zombie-relay healing - lives in the parent
 * (`RobotSessionScreen`). The panel never reaches into the daemon
 * directly. This is the cleanup that buys us:
 *
 *   1. **No redundant probes** on the happy path. Previously every
 *      panel mount fired three serial fetches (token + peerId +
 *      health) before the engine could start, even when we'd just
 *      done the same checks from the parent's handshake screen.
 *      The parent now passes the resolved values down as props.
 *   2. **Lazy zombie-relay healing**. The mount blocks on nothing,
 *      and the parent decides when to heal based on the engine's
 *      live `onAppStateChange` events (5 s in a transient state →
 *      trigger heal in the background, force a remount via
 *      `remountKey` when it lands).
 *   3. **Single source of truth for transport state**. The peer id
 *      comes from the same `RobotClient` (LAN HTTP or WebRTC proxy)
 *      the rest of the screen uses, so remote and local flows take
 *      the exact same code path here.
 *
 * The module-level engine lifecycle queue (kept from the old
 * implementation) is the only piece of cross-instance state we need
 * to retain: it serialises mount/unmount operations across React
 * StrictMode double-invocations and remountKey bumps so we never
 * have two concurrent SSE sessions on HF central.
 */
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  mountConversation,
  type AppState,
  type ConversationEngineHandle,
} from './conversation-engine';
import { useReachySdk } from './useReachySdk';
import { createLogger } from '../logger';
import './conversation.css';

const engineLogger = createLogger('engine');

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
 * Time the engine is allowed to spend in any transient "still making
 * progress" state before we ask the parent to trigger a background
 * heal. Tuned by hand:
 *
 *   - Good LAN path (preselected peer id): `signed-out` → `starting`
 *     → `listening` takes 2-4 s including central's SSE handshake.
 *   - First-mount zombie relay: the SDK never sees the robot in
 *     `robotsChanged`, so the engine sits in `auto-selecting` until
 *     either central recovers (rare) or someone heals the relay.
 *
 * 5 s is high enough that the happy path never wakes the heal up,
 * low enough that a zombie relay is healed within ~10 s end-to-end
 * (5 s detection + ~5 s `/refresh-relay` round-trip).
 */
const LAZY_HEAL_MS = 5_000;

/**
 * Full watchdog timeout: if the engine is STILL transient past this
 * budget, the lazy heal didn't fix the underlying issue and we
 * surface a user-facing retry CTA. Kept above the engine's own 15 s
 * `startSession` guard so a healthy-but-slow path never trips it.
 */
const WATCHDOG_TIMEOUT_MS = 20_000;

/**
 * States that are supposed to be *on the way to* a steady conversation.
 * Staying in any of them past the lazy heal threshold triggers the
 * parent heal callback; staying past the full watchdog budget surfaces
 * the retry CTA. `error` is intentionally omitted because the engine
 * already shows its own message in that case.
 */
const TRANSIENT_STATES = new Set<AppState>([
  'connecting',
  'connected',
  'auto-selecting',
  'starting',
]);

export interface ConversePanelProps {
  /**
   * Resolved peer id passed by the parent (`RobotSessionScreen`).
   * Pass `null` to make the engine fall back to the public
   * "wait for robotsChanged" flow; pass a non-empty string to
   * fast-path `startSession(id)` and skip that wait. The mount
   * effect blocks on `peerIdResolved`, not on the value itself,
   * so a definitive null still releases the gate.
   */
  peerId: string | null;
  /**
   * True once the parent has finished resolving the peer id (success
   * or definitive null). Gating the engine mount on this flag keeps
   * us from briefly mounting with `null`, then re-mounting with the
   * real id once the parent fetch lands.
   */
  peerIdResolved: boolean;
  /**
   * Observer for every engine state-machine transition. The parent
   * uses this to (a) drive the unified screen's stepper UI and
   * (b) decide when to trigger a heal: a transient state held past
   * the parent's own threshold means central / relay are unhappy.
   */
  onAppStateChange?: (state: AppState) => void;
  /**
   * Bumped by the parent to force an engine remount. Used after the
   * parent finishes a heal cycle, so the new engine starts clean
   * instead of inheriting the previous run's stale SSE / data
   * channel state.
   */
  remountKey?: number;
  /**
   * Fired when:
   *   - the engine has been stuck in a transient state for
   *     `LAZY_HEAL_MS` (parent should background-heal).
   *   - the user clicks the watchdog retry CTA (parent decides
   *     whether to re-probe + remount).
   *
   * The parent is responsible for deduping: a `useDaemonRelayHealing`
   * hook coalesces concurrent triggers so multiple fires don't
   * double-POST `/refresh-relay`.
   */
  onStuck?: () => void;
  /**
   * Optional one-line label rendered as a floating overlay on top of
   * the engine. Non-blocking — the engine keeps running underneath.
   * Used by the parent to surface "Reconnecting robot to HuggingFace…"
   * during a heal cycle. Pass null/undefined to hide.
   */
  busyLabel?: string | null;
  /**
   * Optional fatal-style overlay message. When set, it covers the
   * engine entirely and offers the same Retry CTA as the watchdog
   * branch. Used by the parent to render the "restart needed on
   * Reachy" hint when `refreshEndpointAvailable === false` after a
   * heal attempt - a state the panel can't recover from on its own.
   */
  errorMessage?: string | null;
  /**
   * Gate for the conversation pipeline (antennas oscillator, OpenAI
   * Realtime, head wobbler).
   *
   *   - `false` (default): the engine still mounts and brings up the
   *     WebRTC DataChannel as soon as the peer id resolves - the
   *     daemon proxy needs that DC to relay `wake_up` / `goto_sleep`
   *     calls. The conversation parts stay dormant.
   *   - `true`: the parent has decided the user is in the right view
   *     to start talking (in practice: phase === 'live' has been
   *     stable for a stabilisation delay). The panel forwards the
   *     request to the engine which starts the antennas + connects
   *     to OpenAI + wires the wobbler.
   *
   * Toggling false → true → false during a single mount is supported
   * (the engine tears down only the conversation pipeline, not the
   * SDK session).
   */
  convoActive?: boolean;
}

export function ConversePanel({
  peerId,
  peerIdResolved,
  onAppStateChange,
  remountKey = 0,
  onStuck,
  busyLabel = null,
  errorMessage = null,
  convoActive = false,
}: ConversePanelProps): React.ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ConversationEngineHandle | null>(null);
  const { isReady, error: sdkError } = useReachySdk();

  // Watchdog / retry state. The lazy-heal trigger doesn't have a
  // visible component (it asks the parent to heal silently); the
  // full watchdog trip exposes a retry CTA via `watchdogTripped`.
  const [watchdogTripped, setWatchdogTripped] = useState(false);

  // Bumped by the local Retry CTA to force the engine to remount
  // even when the parent's `remountKey` hasn't changed. Keeps a
  // user-driven retry independent from the parent's heal logic.
  const [localRetryKey, setLocalRetryKey] = useState(0);

  // Ref-mirroring the parent callbacks so the long-lived engine
  // closures always see the latest reference without forcing a
  // remount when they change identity.
  const onAppStateChangeRef = useRef(onAppStateChange);
  onAppStateChangeRef.current = onAppStateChange;
  const onStuckRef = useRef(onStuck);
  onStuckRef.current = onStuck;
  // Mirror `convoActive` so the watchdog closure (captured per
  // engine mount) can read the live value. The watchdog is only
  // meaningful while the host actually wants a conversation: once
  // `convoActive` flips false (typically the user tapped Back and
  // the screen entered 'leaving'), the engine parks at "connected"
  // - which is in TRANSIENT_STATES because it's also the in-flight
  // state during a normal startup. Without this gate the watchdog
  // would trip mid-teardown over WebRTC (sleep + motor disable
  // round-tripping through the relay can chew through the 20 s
  // budget) and surface a misleading "Robot unresponsive" CTA on
  // top of a perfectly normal disconnect.
  const convoActiveRef = useRef(convoActive);
  convoActiveRef.current = convoActive;

  const onRetry = useCallback(() => {
    setWatchdogTripped(false);
    setLocalRetryKey((k) => k + 1);
    // Tell the parent we want a fresh state - typically that
    // means: heal + bump its own remountKey + re-resolve peer id.
    onStuckRef.current?.();
  }, []);

  // Engine lifecycle. Reruns when:
  //   - SDK readiness flips (one-time per session)
  //   - peer id finishes resolving (also one-time per parent
  //     resolution cycle)
  //   - peer id value changes (e.g. after a relay heal made it
  //     resolvable for the first time)
  //   - parent bumps remountKey (post-heal forced remount)
  //   - user clicks retry (localRetryKey)
  //   - errorMessage appears (we want to tear down the engine
  //     under the overlay; mounting through `display: none` is
  //     fine for the orb but we want it stopped if we're showing
  //     a hard-stop fallback)
  useEffect(() => {
    if (!isReady) return;
    if (!peerIdResolved) return;
    if (errorMessage) return;
    const root = rootRef.current;
    if (!root) return;

    const token = ++engineMountCounter;
    let aborted = false;
    let localHandle: ConversationEngineHandle | null = null;

    // Per-effect timer pair. Both arm on entry to a transient state,
    // both disarm on exit. The lazy timer fires once and asks the
    // parent to heal; the watchdog timer fires once and surfaces the
    // retry CTA. Re-arming while already armed is a no-op so a
    // chain of transient transitions (connecting → connected →
    // auto-selecting) doesn't reset either clock and hide a real
    // stall.
    let lazyHealTimer: number | null = null;
    let watchdogTimer: number | null = null;
    let lazyHealFired = false;
    const armTimers = (): void => {
      // Don't watchdog a teardown. When the host has explicitly
      // dropped `convoActive` (Back was tapped, screen is in
      // 'leaving') the engine's parking state is the desired
      // terminal, not a stall to surface to the user.
      if (!convoActiveRef.current) return;
      if (lazyHealTimer === null && !lazyHealFired) {
        lazyHealTimer = window.setTimeout(() => {
          lazyHealTimer = null;
          if (!convoActiveRef.current) return;
          lazyHealFired = true;
          engineLogger.info('lazy_heal.trigger', { token });
          onStuckRef.current?.();
        }, LAZY_HEAL_MS);
      }
      if (watchdogTimer === null) {
        watchdogTimer = window.setTimeout(() => {
          watchdogTimer = null;
          if (!convoActiveRef.current) return;
          engineLogger.warn('watchdog.trip', { token });
          setWatchdogTripped(true);
        }, WATCHDOG_TIMEOUT_MS);
      }
    };
    const disarmTimers = (): void => {
      if (lazyHealTimer !== null) {
        window.clearTimeout(lazyHealTimer);
        lazyHealTimer = null;
      }
      if (watchdogTimer !== null) {
        window.clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    };

    engineLifecyclePromise = engineLifecyclePromise.then(async () => {
      if (aborted) return;
      try {
        engineLogger.info('mount', { token, peer_id: peerId ?? null });
        const handle = mountConversation(root, {
          preselectedRobotId: peerId,
          // Mobile app gates the conversation pipeline behind the
          // `convoActive` prop (forwarded below in a dedicated effect).
          // The SDK / DataChannel still comes up immediately because
          // it doubles as the daemon proxy transport during wake-up.
          autoStartConversation: false,
          onStateChange: (state) => {
            engineLogger.info('state.transition', { to: state });
            if (TRANSIENT_STATES.has(state)) {
              armTimers();
            } else {
              disarmTimers();
              // Entering a non-transient healthy state is implicit
              // recovery; clear any prior "stuck" flag so the UI
              // returns to the engine view without a retry click.
              if (state !== 'error') setWatchdogTripped(false);
            }
            // Fan out to the parent observer AFTER the watchdog so
            // internal bookkeeping never blocks on a third-party
            // callback. Errors thrown by the parent are swallowed
            // here so a bad subscriber can't wedge the engine.
            const cb = onAppStateChangeRef.current;
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
        engineLogger.error('mount.error', {
          token,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return () => {
      aborted = true;
      disarmTimers();
      engineLifecyclePromise = engineLifecyclePromise.then(async () => {
        const handle = localHandle;
        localHandle = null;
        if (handle && handleRef.current === handle) {
          handleRef.current = null;
        }
        if (!handle) return;
        engineLogger.info('unmount.start', { token });
        try {
          await handle.unmount();
          engineLogger.info('unmount.complete', { token });
        } catch (err) {
          engineLogger.warn('unmount.error', {
            token,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    };
  }, [isReady, peerIdResolved, peerId, remountKey, localRetryKey, errorMessage]);

  // Forward `convoActive` to the engine. Decoupled from the mount
  // effect so flipping the gate doesn't tear the engine down: the
  // engine has dedicated `startConversation()` / `stopConversation()`
  // entrypoints that only touch the conversation pipeline (antennas /
  // OpenAI / wobbler), leaving the SDK session - and therefore the
  // daemon proxy DataChannel - alive.
  //
  // We chain through `engineLifecyclePromise` so the toggle observes
  // the same ordering as mount/unmount (no race where we'd call
  // `startConversation` on a handle that's about to be torn down by
  // a queued unmount task).
  useEffect(() => {
    if (!isReady || !peerIdResolved || errorMessage) return;
    let cancelled = false;
    engineLifecyclePromise = engineLifecyclePromise.then(async () => {
      if (cancelled) return;
      const handle = handleRef.current;
      if (!handle) return;
      try {
        if (convoActive) {
          engineLogger.info('convo.start', {});
          await handle.startConversation();
        } else {
          engineLogger.info('convo.stop', {});
          await handle.stopConversation();
        }
      } catch (err) {
        engineLogger.warn('convo.toggle.error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [convoActive, isReady, peerIdResolved, errorMessage, remountKey, localRetryKey]);

  // When the host pulls the convo gate down (typically: Back was
  // tapped → screen is in 'leaving'), make sure the watchdog UI
  // doesn't surface during teardown. Two cases to cover:
  //   - watchdog already tripped while we were live → clear the
  //     overlay so the disconnect proceeds without a fake error.
  //   - watchdog armed but not yet tripped → the in-flight timer
  //     callback gates on `convoActiveRef`, so it'll just no-op.
  useEffect(() => {
    if (!convoActive && watchdogTripped) {
      setWatchdogTripped(false);
    }
  }, [convoActive, watchdogTripped]);

  // ─── Render ───────────────────────────────────────────────────────────
  //
  // Display priority:
  //   1. SDK error           - nothing we can do without the SDK module
  //   2. Parent error        - parent-supplied fatal (e.g. restart needed)
  //   3. Watchdog tripped    - engine mounted but stuck > WATCHDOG_TIMEOUT
  //   4. Engine view         - default; busyLabel renders as a soft overlay
  const fatalMessage = sdkError?.message ?? errorMessage ?? null;

  const engineVisible =
    isReady &&
    peerIdResolved &&
    !fatalMessage &&
    !watchdogTripped;

  return (
    <Box sx={{ position: 'relative', flex: 1, minHeight: 0, width: '100%' }}>
      {fatalMessage ? (
        <Box sx={centeredFallbackSx}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            Cannot start conversation
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ textAlign: 'center', px: 3, mb: 3, maxWidth: 320 }}
          >
            {fatalMessage}
          </Typography>
          <Button variant="contained" onClick={onRetry} sx={retryBtnSx}>
            Retry
          </Button>
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

      {!fatalMessage && !watchdogTripped && busyLabel ? (
        <Box sx={busyOverlaySx}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary" sx={{ ml: 1.5 }}>
            {busyLabel}
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

// Fallback overlays sit ON TOP of the embedded conversation root, so
// they need to fully mask whatever the engine has rendered behind
// them. Match the host MUI palette (paper + primary text) instead of
// the engine's old hard-coded dark background, so the overlay reads
// correctly in both light and dark themes.
const centeredFallbackSx = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  bgcolor: 'background.paper',
  color: 'text.primary',
  zIndex: 2,
} as const;

// Soft overlay: the engine is still visible underneath. We pin a
// small status pill at the top of the panel so the user knows
// something is happening (heal in flight) without losing the
// orb / caption. Aligns with the transport pill on the right of
// the engine's topbar.
const busyOverlaySx = {
  position: 'absolute',
  top: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  px: 2,
  py: 1,
  borderRadius: 999,
  bgcolor: 'background.paper',
  boxShadow: 1,
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

    <button id="main-circle" class="circle" type="button" aria-label="Start voice conversation">
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

  <p id="circle-caption" class="circle-caption empty" role="status"></p>

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
