/**
 * Robot session hook.
 *
 * Single source of truth for the robot connect / disconnect lifecycle
 * (layers A + B + C in the architectural separation). The hook owns
 * the conversation engine handle and exposes session-level commands
 * to the host:
 *
 *   - `releaseForHandoff()`  release the WebRTC session for an
 *                            iframe handoff (B-only). The robot
 *                            stays awake; the embed can dial in.
 *   - `reacquire()`          bring the WebRTC session back up
 *                            after a release, without re-running
 *                            the wake-up dance.
 *   - `tearDown()`           full teardown (A + B + C all going
 *                            down: gotoSleep + motors disabled +
 *                            stopSession + disconnect).
 *
 * The conversation pipeline (layer D - HF realtime, antennas,
 * head wobbler) is also owned by the engine but treated as a
 * SEPARATE lifecycle: the panel toggles it via
 * `startConversation()` / `stopConversation()`.
 *
 * Why hoist this to a hook
 * ────────────────────────
 * Before this refactor, `<ConversationPanel>` owned both the engine
 * lifecycle AND the orb chrome, which meant unmounting the panel
 * (e.g. on a tab switch) tore down the WebRTC session. That coupling
 * forced the host to choose between "leave the robot connected" and
 * "show another tab" - which is exactly the wrong tradeoff for the
 * apps tab.
 *
 * Now the hook owns the lifecycle, the panel is a pure consumer of
 * the orb-relevant state, and the screen orchestrates session
 * transitions independently of which tab is active.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { chainLifecycle } from '@/features/robot-session/lifecycle-queue';
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';
import {
  fetchRobotsFromCentral,
  extractRobotHardwareId,
  extractRobotId,
} from '@/features/auth/fetchRobotsFromCentral';
import {
  mountConversation,
  type ConnectionState,
  type ConversationState,
  type ConversationConnectionAttempt,
  type ConversationEngineHandle,
  type ConversationToolToastEvent,
  type ConversationTransportInfo,
} from '@/features/conversation/engine/conversation-engine';

import { derivePhase, type SessionPhase } from './phase';

// Re-exported so existing call sites that import `SessionPhase` /
// `derivePhase` from this module keep working without churn.
export { derivePhase };
export type { SessionPhase };

export interface RobotSessionHandle {
  /** High-level phase observed by the host. Use this to drive the
   *  primary transition overlays (connecting / leaving / etc.). */
  phase: SessionPhase;
  /** Transport / connection FSM state. Drives the bring-up overlay
   *  and the "is a robot reachable" question. */
  connectionState: ConnectionState;
  /** AI conversation FSM state. Use this for the orb chrome's live
   *  visual (distinguishing `listening` from `ai-speaking`, etc.).
   *  Only ever non-`idle` while `connectionState === 'live'`. */
  conversationState: ConversationState;
  /** Last fatal error message surfaced by the engine, or null. */
  errorMessage: string | null;
  /** Mic gate state mirrored from the engine. */
  micMuted: boolean;
  /** Most recent tool-call toast label, or null when dismissed. */
  toolToastLabel: string | null;
  /** Visual intent of the current tool-call toast. `"error"` when the
   *  last surfaced tool call failed (e.g. a VLM error behind `look`). */
  toolToastVariant: "info" | "error";
  /** Whether the engine has reached `ready` (or further) at least
   *  once on the current session. Sticky: stays true through
   *  releases / re-acquires until `tearDown()` resets it. */
  hasReachedReady: boolean;
  /**
   * In-flight connection-retry info, or `null` when no retry is
   * happening (either we are on the first attempt or we have
   * already succeeded / given up). The host shows a "Reconnecting…
   * (n of m)" caption inside the connecting overlay when this is
   * non-null AND `attempt > 1`.
   *
   * Reset to `null` on every successful connection or fatal error,
   * so it never bleeds across session attempts.
   */
  connectionAttempt: ConversationConnectionAttempt | null;
  /**
   * Live snapshot of the WebRTC transport used by the audio peer
   * connection: ICE candidate-pair classification (`lan` / `direct`
   * / `relay`) + instantaneous bitrate in bits per second.
   *
   * `null` when no value has been observed yet (engine still
   * booting / SDK pc not up yet). Updates roughly every 1.5 s while
   * the session pc is alive; freezes (stays at its last value) when
   * the conversation stops but the session is still up - and clears
   * back to `null` only when the session itself is torn down or
   * released.
   *
   * Lifecycle is owned by `RobotSession` (the monitor follows the
   * session pc, not the conversation pipeline) - the host just
   * renders whatever lands in this state.
   */
  webrtcTransport: ConversationTransportInfo | null;
  /**
   * Daemon version resolved as part of the connection bring-up (emitted
   * just before the connection reaches `live`), or `null` when unknown
   * (read timed out / daemon doesn't expose a version / pre-`live`).
   *
   * This is the source of truth for the update gate: because it lands
   * BEFORE the session UI is shown, the gate can decide without the
   * post-connect "pop" the old post-`ready` round-trip caused. Reset to
   * `null` on `tearDown()`; re-emitted after a post-update reboot.
   */
  daemonVersion: string | null;

  /** Conversation parts (D layer): start / stop the HF realtime
   *  pipeline, antennas, head wobbler. No-op if the engine isn't
   *  ready yet (the call is queued and runs on the next viable
   *  transition). */
  startConversation: () => Promise<void>;
  stopConversation: () => Promise<void>;
  /**
   * Restart the conversation parts in place. Used after a
   * personality switch so the running realtime client picks up the
   * new instructions + voice without the user having to stop and
   * start again manually. No-op when no conversation is active.
   */
  restartConversation: () => Promise<void>;

  /** Forward a tap on the orb. The engine decides what to do based
   *  on the current FSM state. */
  triggerOrbAction: () => Promise<void>;
  /** Toggle the robot's microphone gate. */
  setMicMuted: (muted: boolean) => void;
  /** Programmatically end the conversation (mirror of the orb's
   *  stop side button). The engine drops back to `authenticated`
   *  or `signed-out`. */
  requestStop: () => Promise<void>;

  /** Release the WebRTC session for an iframe handoff. Robot stays
   *  awake, HF auth + SSE stay open. Resolves once central has been
   *  notified - safe to mount the iframe right after. */
  releaseForHandoff: () => Promise<void>;
  /** Re-acquire the WebRTC session after a previous release. Skips
   *  wake-up. Resolves once `startSession` has completed. */
  reacquire: () => Promise<void>;
  /** In-place recovery after a transport-level fatal on a session
   *  that had already reached ready. Drives the `recovering` phase
   *  (compact overlay) while the engine re-runs the bring-up + wake.
   *  If it fails, the engine lands back on `error` and the host's
   *  error view takes over. */
  recover: () => Promise<void>;
  /** Full session teardown (sleep + motors disabled + stopSession +
   *  disconnect). Used by the host before navigating away from the
   *  screen. Resolves once the engine's lifecycle queue has drained. */
  tearDown: () => Promise<void>;

  // ─── Audio volume controls (pass-through to the SDK) ──────────────
  //
  // All four resolve with the daemon's *applied* value (post-clamp)
  // or `null` if the platform doesn't expose volume control / the
  // SDK isn't ready. Non-throwing.

  /** Read the current speaker volume on the robot (0-100). */
  getSpeakerVolume: () => Promise<number | null>;
  /** Push a new speaker volume to the robot (0-100). */
  setSpeakerVolume: (volume: number) => Promise<number | null>;
  /** Read the current microphone input volume on the robot (0-100). */
  getMicrophoneVolume: () => Promise<number | null>;
  /** Push a new microphone input volume (0-100). */
  setMicrophoneVolume: (volume: number) => Promise<number | null>;

  /** Read the daemon's reported version string. Resolves to `null`
   *  when the channel isn't open or the daemon predates `get_version`. */
  getDaemonVersion: () => Promise<string | null>;

  /** Trigger a daemon self-update over the data channel (fire-and-ack;
   *  the daemon updates then `systemctl restart`s, dropping the
   *  session). Returns `false` when the channel isn't open. */
  startDaemonUpdate: (options?: { preRelease?: boolean }) => boolean;

  /**
   * Latest measured microphone level in [0, 1]. Sampled on every
   * audio frame inside the engine (via the level monitor's `onLevels`
   * callback) so consumers can drive a 60 Hz visualiser without
   * triggering React re-renders. Returns `0` when the conversation
   * isn't active.
   */
  getMicLevel: () => number;

  /**
   * Play one of the daemon's bundled sound files on the robot's
   * speaker. Returns `true` when the command was queued, `false`
   * if the DataChannel isn't open / the engine isn't ready.
   * Non-throwing.
   */
  playSound: (file: string) => boolean;

  /**
   * Subscribe to the daemon's `journalctl -u reachy-mini-daemon`
   * stream over the WebRTC data channel. Returns an `unsubscribe()`
   * callback that's safe to call more than once.
   *
   * Pass-through to the engine (which itself wraps the SDK's
   * `subscribeLogs`). When the engine isn't mounted yet, returns a
   * noop unsubscribe; consumers are expected to re-call this every
   * time the session reaches `ready` (typically inside a
   * `useEffect` keyed on `hasReachedReady`).
   */
  subscribeLogs: (options: {
    onLine: (entry: { timestamp: string; line: string }) => void;
    onError?: (error: string) => void;
  }) => () => void;

  /**
   * Raw SDK instance accessor, or `null` when no session is live.
   * Low-level escape hatch for the first wake-up wizard (reading the
   * robot mic track off `_pc`, replaying the wake-up trajectory). Most
   * consumers should prefer the dedicated pass-throughs above.
   */
  getRobot: () => ReachyMiniInstance | null;

  /**
   * Bind the robot's video stream to a `<video>` element (with cache
   * replay for late mounts). Returns a detach callback.
   */
  attachVideo: (videoElement: HTMLVideoElement) => () => void;
}

interface UseRobotSessionOptions {
  /** Central peer id of the robot the user picked upstream. Used as
   *  the engine mount key and the initial connect target - but the
   *  engine re-resolves the live peer id (see `robotHardwareId`) before
   *  each `startSession`, because this snapshot can go stale. */
  robotId: string;
  /**
   * Stable hardware id of the picked robot (from the central listing's
   * `meta.hardware_id`), or `null` for a daemon too old to expose one.
   * When present, the engine re-resolves the live peer id from central
   * by matching this id right before each connect, self-healing against
   * the peer-id rotation that breaks the bare `robotId` snapshot.
   */
  robotHardwareId?: string | null;
  /** Display name of the picked robot. Used by `recover()` to remap
   *  the dial target when the daemon restarted (fresh peer id). */
  robotName?: string | null;
  /** HF token, kept on the panel's session storage by upstream
   *  auth hook. Forwarded here so the engine can re-seed if it
   *  gets cleared mid-session. */
  token: string;
  /** Element onto which the engine writes audio-reactive CSS
   *  variables (the orb root). Read lazily when the level monitors
   *  spin up at conversation-start time, so it's fine for this ref
   *  to populate slightly after the hook mounts. */
  audioLevelsTargetRef: React.RefObject<HTMLElement | null>;
  /** Bring-up gate: when it returns true, the engine defers the initial
   *  wake-up to the host so the first-wake-up wizard's motor step owns
   *  the very first `wakeUp()`. Evaluated fresh on every bring-up (read
   *  through a ref), so the host can flip it between sessions. */
  shouldDeferInitialWakeUp?: () => boolean;
}

const TOOL_TOAST_MIN_MS = 1500;

export function useRobotSession({
  robotId,
  robotHardwareId,
  robotName,
  token,
  audioLevelsTargetRef,
  shouldDeferInitialWakeUp,
}: UseRobotSessionOptions): RobotSessionHandle {
  const handleRef = useRef<ConversationEngineHandle | null>(null);
  // Keep the latest host getter in a ref so the engine (mounted once per
  // `robotId`) always reads the current value at bring-up instead of the
  // closure captured on first render.
  const shouldDeferInitialWakeUpRef = useRef(shouldDeferInitialWakeUp);
  shouldDeferInitialWakeUpRef.current = shouldDeferInitialWakeUp;
  // Token + hardware id are read through refs by the peer-id resolver
  // below: the engine mounts once per `robotId`, so the resolver closure
  // must see the CURRENT token / hardware id rather than the values
  // captured on first render.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const hardwareIdRef = useRef(robotHardwareId ?? null);
  hardwareIdRef.current = robotHardwareId ?? null;
  // Used for StrictMode-safe mount: a fast remount could race with
  // the previous engine's teardown if we didn't gate on a per-mount
  // cancel token.
  const cancelTokenRef = useRef<{ cancelled: boolean } | null>(null);

  const [connectionState, setConnectionState] =
    useState<ConnectionState>('signed-out');
  const [conversationState, setConversationState] =
    useState<ConversationState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [toolToastLabel, setToolToastLabel] = useState<string | null>(null);
  const [toolToastVariant, setToolToastVariant] = useState<"info" | "error">(
    "info",
  );
  const [hasReachedReady, setHasReachedReady] = useState(false);
  const [daemonVersion, setDaemonVersion] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] =
    useState<ConversationConnectionAttempt | null>(null);
  const [webrtcTransport, setWebrtcTransport] =
    useState<ConversationTransportInfo | null>(null);
  /**
   * `phaseHint` captures the in-flight handoff transitions that the
   * engine doesn't model itself: `releasing`, `reacquiring`,
   * `tearing-down`. It's null whenever the engine state is the
   * source of truth.
   */
  const [phaseHint, setPhaseHint] = useState<SessionPhase | null>(null);

  // Re-seed the HF token into sessionStorage whenever it changes.
  // The engine's `authenticate()` reads from sessionStorage; the
  // upstream hook (`useRemoteHfToken`) does this same write but we
  // mirror it here as a safety net for future refactors that might
  // bypass the hook.
  useEffect(() => {
    if (!token) return;
    try {
      const existing = sessionStorage.getItem('hf_token');
      if (existing !== token) {
        sessionStorage.setItem('hf_token', token);
      }
    } catch (err) {
      console.warn('[session] failed to seed sessionStorage.hf_token:', err);
    }
  }, [token]);

  // Sticky `hasReachedReady` latch. We flip on the first `live`
  // connection. Stays true through a release+reacquire cycle so
  // the host doesn't replay the connecting overlay every time. Reset
  // explicitly inside `tearDown()` so the next session starts fresh.
  useEffect(() => {
    if (hasReachedReady) return;
    if (connectionState === 'live') {
      setHasReachedReady(true);
    }
  }, [connectionState, hasReachedReady]);

  // Engine lifecycle. Mounts on first render with the current
  // `robotId`; tears down on unmount or on a `robotId` change. The
  // module-level `chainLifecycle` queue serialises this with any
  // other engine activity (release / reacquire / fast remounts in
  // StrictMode).
  useEffect(() => {
    const cancelToken = { cancelled: false };
    cancelTokenRef.current = cancelToken;
    let mountedHandle: ConversationEngineHandle | null = null;

    void chainLifecycle(async () => {
      if (cancelToken.cancelled) return;
      // Inert host node: we don't expose this to React because the
      // engine no longer writes DOM into it. A bare detached div is
      // sufficient for the legacy API contract.
      const inertRoot = document.createElement('div');

      const handle = mountConversation(inertRoot, {
        preselectedRobotId: robotId,
        autoStartConversation: false,
        // Read through the ref so the engine always sees the host's
        // current first-wake-up decision, not the one at mount time.
        shouldDeferInitialWakeUp: () =>
          shouldDeferInitialWakeUpRef.current?.() ?? false,
        // Re-resolve the live peer id from central by the robot's stable
        // hardware id right before each connect. The bare `robotId` we
        // mounted with is a snapshot that rotates on every relay
        // reconnect, so dialing it directly is the main reason a
        // connection would hang. Returns `null` (⇒ keep the captured id)
        // when we have no hardware id / token or central can't match it.
        resolvePeerId: async (): Promise<string | null> => {
          const hwid = hardwareIdRef.current;
          const tok = tokenRef.current;
          if (!hwid || !tok) return null;
          try {
            const res = await fetchRobotsFromCentral(tok);
            if (!res.ok) return null;
            const match = res.robots.find(
              (r) => extractRobotHardwareId(r) === hwid,
            );
            return match ? extractRobotId(match) : null;
          } catch (err) {
            console.warn('[session] peer-id re-resolution failed:', err);
            return null;
          }
        },
        // Pass a *getter*, not `audioLevelsTargetRef.current`: the
        // orb DOM may be unmounted/remounted while the engine
        // stays alive (tab switches between Conv ↔ Apps, iframe
        // release/reacquire). The engine re-reads this on every
        // audio frame so its CSS-var writes always hit the
        // currently-mounted orb instead of an old detached node.
        audioLevelsTarget: () => audioLevelsTargetRef.current,
        onConnectionStateChange: (state) => {
          if (cancelToken.cancelled) return;
          setConnectionState(state);
        },
        onConversationStateChange: (state) => {
          if (cancelToken.cancelled) return;
          setConversationState(state);
        },
        onErrorMessageChange: (message) => {
          if (cancelToken.cancelled) return;
          setErrorMessage(message);
        },
        onMicMutedChange: (muted) => {
          if (cancelToken.cancelled) return;
          setMicMuted(muted);
        },
        onToolToast: (event: ConversationToolToastEvent) => {
          if (cancelToken.cancelled) return;
          setToolToastLabel(event.label);
          setToolToastVariant(event.variant ?? "info");
          const dismiss = Math.max(event.durationMs, TOOL_TOAST_MIN_MS);
          window.setTimeout(() => {
            if (cancelToken.cancelled) return;
            setToolToastLabel((current) =>
              current === event.label ? null : current,
            );
          }, dismiss);
        },
        onConnectionAttempt: (info) => {
          if (cancelToken.cancelled) return;
          setConnectionAttempt(info);
        },
        onDaemonVersionChange: (version) => {
          if (cancelToken.cancelled) return;
          setDaemonVersion(version);
        },
        onTransportChange: (info) => {
          if (cancelToken.cancelled) return;
          setWebrtcTransport(info);
        },
      });
      if (cancelToken.cancelled) {
        try {
          await handle.unmount();
        } catch (err) {
          console.warn('[session] race unmount failed:', err);
        }
        return;
      }
      mountedHandle = handle;
      handleRef.current = handle;
    });

    return () => {
      cancelToken.cancelled = true;
      cancelTokenRef.current = null;
      const handle = mountedHandle ?? handleRef.current;
      if (handleRef.current === handle) handleRef.current = null;
      if (!handle) return;
      // Push the unmount through the same queue so a fast remount
      // (StrictMode, parent re-render with a different robotId)
      // waits for this teardown to complete before firing its own
      // mount. Resets `phaseHint` so the next mount starts fresh.
      void chainLifecycle(async () => {
        try {
          await handle.unmount();
        } catch (err) {
          console.warn('[session] unmount failed:', err);
        }
      });
    };
    // We deliberately depend on `robotId` only - changing tokens
    // shouldn't tear the engine down (the engine re-reads
    // sessionStorage on its own).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robotId]);

  const startConversation = useCallback(async (): Promise<void> => {
    const handle = handleRef.current;
    if (!handle) return;
    await handle.startConversation();
  }, []);

  const stopConversation = useCallback(async (): Promise<void> => {
    const handle = handleRef.current;
    if (!handle) return;
    await handle.stopConversation();
  }, []);

  const restartConversation = useCallback(async (): Promise<void> => {
    const handle = handleRef.current;
    if (!handle) return;
    await handle.restartConversation();
  }, []);

  const triggerOrbAction = useCallback(async (): Promise<void> => {
    const handle = handleRef.current;
    if (!handle) return;
    await handle.triggerOrbAction();
  }, []);

  const setMicMutedCmd = useCallback((muted: boolean): void => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.setMicMuted(muted);
  }, []);

  const requestStop = useCallback(async (): Promise<void> => {
    const handle = handleRef.current;
    if (!handle) return;
    await handle.requestStop();
  }, []);

  const releaseForHandoff = useCallback(async (): Promise<void> => {
    const handle = handleRef.current;
    if (!handle) return;
    setPhaseHint('releasing');
    try {
      await chainLifecycle(async () => {
        await handle.releaseSessionKeepAwake();
      });
    } finally {
      setPhaseHint('released');
    }
  }, []);

  const reacquire = useCallback(async (): Promise<void> => {
    const handle = handleRef.current;
    if (!handle) return;
    setPhaseHint('reacquiring');
    try {
      await chainLifecycle(async () => {
        await handle.reacquireSession();
      });
    } finally {
      // Drop back to engine-driven phase so the next state change
      // (e.g. `ready`) flows through `derivePhase` normally.
      setPhaseHint(null);
    }
  }, []);

  const recover = useCallback(async (): Promise<void> => {
    const handle = handleRef.current;
    if (!handle) return;
    setPhaseHint('recovering');
    try {
      await chainLifecycle(async () => {
        // Pass the host's robot identity: the engine's own selected id
        // is nulled by the unsolicited-drop cleanup, and the id itself
        // may be dead (daemon restart ⇒ fresh central peer id), so the
        // engine re-resolves the dial target - by name if needed.
        await handle.recoverSession({ robotId, robotName });
      });
    } finally {
      // Back to engine-driven phase: `live` on success, `error` when
      // the recovery attempt failed (the engine re-ran onFatalError).
      setPhaseHint(null);
    }
  }, [robotId, robotName]);

  const tearDown = useCallback(async (): Promise<void> => {
    const handle = handleRef.current;
    if (!handle) {
      setPhaseHint(null);
      return;
    }
    setPhaseHint('tearing-down');
    try {
      await chainLifecycle(async () => {
        await handle.unmount();
      });
    } finally {
      handleRef.current = null;
      setPhaseHint('idle');
      setHasReachedReady(false);
      // The next session starts with a fresh transport readout; if
      // we kept the stale one the badge would show a confusing
      // "previous run" value during the connecting overlay.
      setWebrtcTransport(null);
      // Same reasoning for the version: the next bring-up re-resolves
      // it, so drop the stale value to keep the update gate dormant
      // until the fresh read lands.
      setDaemonVersion(null);
    }
  }, []);

  // Audio volume pass-throughs. All four return `null` if the
  // engine hasn't booted yet; the consumer's UI can keep its
  // current value displayed (typically the last seen one) or fall
  // back to a sensible default.
  const getSpeakerVolume = useCallback(async (): Promise<number | null> => {
    return handleRef.current?.getSpeakerVolume() ?? Promise.resolve(null);
  }, []);

  const setSpeakerVolume = useCallback(
    async (volume: number): Promise<number | null> => {
      return handleRef.current?.setSpeakerVolume(volume) ?? Promise.resolve(null);
    },
    [],
  );

  const getMicrophoneVolume = useCallback(async (): Promise<number | null> => {
    return handleRef.current?.getMicrophoneVolume() ?? Promise.resolve(null);
  }, []);

  const setMicrophoneVolume = useCallback(
    async (volume: number): Promise<number | null> => {
      return (
        handleRef.current?.setMicrophoneVolume(volume) ?? Promise.resolve(null)
      );
    },
    [],
  );

  const getDaemonVersion = useCallback(async (): Promise<string | null> => {
    return handleRef.current?.getDaemonVersion() ?? Promise.resolve(null);
  }, []);

  const startDaemonUpdate = useCallback(
    (options?: { preRelease?: boolean }): boolean => {
      return handleRef.current?.startDaemonUpdate(options) ?? false;
    },
    [],
  );

  // Mic level getter: the engine writes its smoothed value into a
  // closure-level variable on every audio frame; here we just read
  // it via the handle. Returning `0` when the engine isn't mounted
  // matches the engine's own "no conversation = no level" contract.
  const getMicLevel = useCallback((): number => {
    return handleRef.current?.getMicLevel() ?? 0;
  }, []);

  const playSound = useCallback((file: string): boolean => {
    return handleRef.current?.playSound(file) ?? false;
  }, []);

  const getRobot = useCallback((): ReachyMiniInstance | null => {
    return handleRef.current?.getRobot() ?? null;
  }, []);

  const attachVideo = useCallback(
    (videoElement: HTMLVideoElement): (() => void) => {
      return handleRef.current?.attachVideo(videoElement) ?? (() => {});
    },
    [],
  );

  const subscribeLogs = useCallback<RobotSessionHandle['subscribeLogs']>(
    (options) => {
      const handle = handleRef.current;
      if (!handle) return () => {};
      return handle.subscribeLogs(options);
    },
    [],
  );

  const phase = derivePhase(connectionState, phaseHint);

  return {
    phase,
    connectionState,
    conversationState,
    errorMessage,
    micMuted,
    toolToastLabel,
    toolToastVariant,
    hasReachedReady,
    daemonVersion,
    connectionAttempt,
    webrtcTransport,
    startConversation,
    stopConversation,
    restartConversation,
    triggerOrbAction,
    setMicMuted: setMicMutedCmd,
    requestStop,
    releaseForHandoff,
    reacquire,
    recover,
    tearDown,
    getSpeakerVolume,
    setSpeakerVolume,
    getMicrophoneVolume,
    setMicrophoneVolume,
    getDaemonVersion,
    startDaemonUpdate,
    getMicLevel,
    playSound,
    subscribeLogs,
    getRobot,
    attachVideo,
  };
}
