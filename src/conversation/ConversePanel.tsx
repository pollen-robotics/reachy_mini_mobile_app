/**
 * Slim React wrapper around the (now headless) conversation engine.
 *
 * Layout owned by React
 * ─────────────────────
 * The orb, caption, side buttons and tool-toast are React components
 * (see `./orb/`). The engine does NOT inject any DOM here anymore: it
 * reports state via `onStateChange`, audio levels via
 * `audioLevelsTarget` (CSS variables on the orb element) and tool
 * calls via `onToolToast`. That keeps a single source of truth for
 * the visual state - what React renders is what you see.
 *
 *   - it mounts / unmounts `mountConversation()` against an inert
 *     placeholder when the inputs it needs from the parent are ready,
 *   - it surfaces overlays for SDK errors, parent-driven busy
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
import { Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  mountConversation,
  type AppState,
  type ConversationEngineHandle,
  type ConversationLevelEvent,
  type ConversationToolToastEvent,
  type ConversationTransportKind,
} from './conversation-engine';
import { useReachySdk } from './useReachySdk';
import { createLogger } from '../logger';
import { ConversationOrb, type OrbState } from './orb/ConversationOrb';
import { ConversationCaption } from './orb/ConversationCaption';
import { MuteSideButton, StopSideButton } from './orb/ConversationSideButtons';
import { ConversationToolToast } from './orb/ConversationToolToast';

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
 * Tool-toast auto-dismiss budget. The engine emits the label + a
 * `durationMs` hint; we still cap it client-side to avoid a stuck
 * toast if a buggy engine fires durationMs=Infinity.
 */
const TOOL_TOAST_MAX_MS = 6_000;

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

/**
 * Live conversation states - the user can mute / hang up here. Used
 * to decide whether the side buttons should expand into view.
 */
const LIVE_STATES = new Set<AppState>([
  'listening',
  'user-speaking',
  'processing',
  'ai-speaking',
]);

/**
 * Map the engine's full `AppState` union onto the smaller `OrbState`
 * the React orb cares about. Several engine states share the same
 * visual (idle ring, yellow spinner) on mobile, where auth + robot
 * selection are decided upstream before the orb even mounts.
 */
function appStateToOrbState(state: AppState): OrbState {
  switch (state) {
    case 'signed-out':
    case 'authenticated':
      return 'idle';
    case 'connecting':
    case 'connected':
    case 'auto-selecting':
    case 'starting':
      return 'connecting';
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
    default:
      return 'idle';
  }
}

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
   * the engine. Non-blocking - the engine keeps running underneath.
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
  /**
   * Forwarded to the engine's `onTransportChange` option. Fires once
   * per ICE classification change (`checking` → `lan`/`direct`/`relay`)
   * after the conversation pipeline has started. Used by the parent
   * to feed `connectionSummary`; falsy means "I don't care about the
   * transport".
   */
  onTransportChange?: (kind: ConversationTransportKind) => void;
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
  onTransportChange,
}: ConversePanelProps): React.ReactElement {
  // The orb element doubles as the audio-levels target: the engine
  // writes `--audio-level`, `--ai-audio-level`, `--bar0..--bar4`
  // directly on it via `options.audioLevelsTarget`, so the 60 Hz
  // audio loop never goes through React.
  const orbRef = useRef<HTMLButtonElement | null>(null);
  const handleRef = useRef<ConversationEngineHandle | null>(null);
  const { isReady, error: sdkError } = useReachySdk();

  // Engine-driven UI state. All four mirror the engine's internal
  // truth via callbacks; we never mutate them imperatively from the
  // host side (clicking the orb / mute / stop just calls into the
  // engine which fans the resulting state change back to us).
  const [appState, setAppState] = useState<AppState>('connecting');
  const [micMuted, setMicMuted] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [toolLabel, setToolLabel] = useState<string | null>(null);

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
  const onTransportChangeRef = useRef(onTransportChange);
  onTransportChangeRef.current = onTransportChange;
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

  // Tool toast: auto-dismiss after the engine-supplied duration,
  // capped client-side. We keep the ID in a ref so back-to-back
  // tool calls don't have the second one's clear racing the first
  // one's display.
  const toolDismissRef = useRef<number | null>(null);
  const handleToolToast = useCallback(
    (toast: ConversationToolToastEvent) => {
      setToolLabel(toast.label);
      if (toolDismissRef.current !== null) {
        window.clearTimeout(toolDismissRef.current);
      }
      const ms = Math.min(
        TOOL_TOAST_MAX_MS,
        Math.max(800, toast.durationMs || 1800),
      );
      toolDismissRef.current = window.setTimeout(() => {
        toolDismissRef.current = null;
        setToolLabel(null);
      }, ms);
    },
    [],
  );
  useEffect(() => {
    return () => {
      if (toolDismissRef.current !== null) {
        window.clearTimeout(toolDismissRef.current);
        toolDismissRef.current = null;
      }
    };
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
    const orb = orbRef.current;
    if (!orb) return;

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
        const handle = mountConversation(orb, {
          preselectedRobotId: peerId,
          // Mobile app gates the conversation pipeline behind the
          // `convoActive` prop (forwarded below in a dedicated effect).
          // The SDK / DataChannel still comes up immediately because
          // it doubles as the daemon proxy transport during wake-up.
          autoStartConversation: false,
          // Audio reactivity goes straight on the orb element via CSS
          // custom properties; no React reconciliation per audio
          // frame.
          audioLevelsTarget: orb,
          onLevels: (_level: ConversationLevelEvent) => {
            // No-op: we read the levels through CSS variables on
            // `audioLevelsTarget` directly. The callback is wired
            // for parity / future instrumentation.
          },
          onToolToast: (toast) => handleToolToast(toast),
          onMicMutedChange: (muted) => setMicMuted(muted),
          onErrorMessageChange: (message) => setErrorDetail(message),
          onTransportChange: (kind) => {
            const cb = onTransportChangeRef.current;
            if (!cb) return;
            try {
              cb(kind);
            } catch (err) {
              console.warn('[ConversePanel] onTransportChange threw:', err);
            }
          },
          onStateChange: (state) => {
            engineLogger.info('state.transition', { to: state });
            setAppState(state);
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
  }, [
    isReady,
    peerIdResolved,
    peerId,
    remountKey,
    localRetryKey,
    errorMessage,
    handleToolToast,
  ]);

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

  const orbState = useMemo(() => appStateToOrbState(appState), [appState]);
  const live = LIVE_STATES.has(appState);

  const handleOrbClick = useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return;
    void handle.triggerOrbAction();
  }, []);
  const handleToggleMute = useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.setMicMuted(!micMuted);
  }, [micMuted]);
  const handleStop = useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return;
    void handle.requestStop();
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────
  //
  // Display priority:
  //   1. SDK error           - nothing we can do without the SDK module
  //   2. Parent error        - parent-supplied fatal (e.g. restart needed)
  //   3. Watchdog tripped    - engine mounted but stuck > WATCHDOG_TIMEOUT
  //   4. Engine view         - default; busyLabel renders as a soft overlay
  const fatalMessage = sdkError?.message ?? errorMessage ?? null;
  const engineVisible = isReady && peerIdResolved && !fatalMessage && !watchdogTripped;

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

      <Stack
        alignItems="center"
        justifyContent="center"
        spacing={2}
        sx={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          height: '100%',
          display: engineVisible ? 'flex' : 'none',
          py: 4,
        }}
      >
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="center"
          spacing={2}
        >
          <MuteSideButton
            live={live}
            micMuted={micMuted}
            onToggleMute={handleToggleMute}
          />
          <ConversationOrb
            audioRef={orbRef}
            state={orbState}
            onClick={handleOrbClick}
            disabled={live}
            ariaLabel={ORB_ARIA_BY_STATE[orbState]}
          />
          <StopSideButton live={live} onStop={handleStop} />
        </Stack>
        <ConversationCaption state={orbState} message={errorDetail} />
        <ConversationToolToast label={toolLabel} />
      </Stack>
    </Box>
  );
}

const ORB_ARIA_BY_STATE: Record<OrbState, string> = {
  idle: 'Start voice conversation',
  connecting: 'Connecting',
  listening: 'Listening',
  'user-speaking': 'Listening',
  processing: 'Processing',
  'ai-speaking': 'Reachy is speaking',
  error: 'Tap to retry',
};

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
// orb / caption.
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
