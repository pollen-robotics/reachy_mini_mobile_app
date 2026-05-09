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
 * The conversation pipeline (layer D - OpenAI Realtime, antennas,
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

import { chainLifecycle } from '@/features/conversation/lifecycle';
import {
  mountConversation,
  type AppState,
  type ConversationConnectionAttempt,
  type ConversationEngineHandle,
  type ConversationToolToastEvent,
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
  /** Raw engine FSM state. Use this for the orb chrome or for
   *  fine-grained UX (e.g. distinguishing `listening` from `ai-
   *  speaking`). */
  engineState: AppState;
  /** Last fatal error message surfaced by the engine, or null. */
  errorMessage: string | null;
  /** Mic gate state mirrored from the engine. */
  micMuted: boolean;
  /** Most recent tool-call toast label, or null when dismissed. */
  toolToastLabel: string | null;
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

  /** Conversation parts (D layer): start / stop the OpenAI Realtime
   *  pipeline, antennas, head wobbler. No-op if the engine isn't
   *  ready yet (the call is queued and runs on the next viable
   *  transition). */
  startConversation: () => Promise<void>;
  stopConversation: () => Promise<void>;

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
  /** Full session teardown (sleep + motors disabled + stopSession +
   *  disconnect). Used by the host before navigating away from the
   *  screen. Resolves once the engine's lifecycle queue has drained. */
  tearDown: () => Promise<void>;
  /**
   * Bind a `<video>` element to the robot's camera stream. Returns a
   * detach function the caller MUST run on unmount. The binding is
   * resilient to release / reacquire cycles (the SDK clears the
   * `srcObject` on `stopSession` and refills it on the next
   * `videoTrack` event), so the host can attach once and forget.
   *
   * Safe to call before the engine has finished mounting: if the
   * underlying SDK instance isn't ready yet we return a no-op so the
   * host's effect cleanup is symmetric.
   */
  attachVideo: (videoElement: HTMLVideoElement) => () => void;

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
   * Push an absolute head orientation (degrees) to the robot. Thin
   * pass-through to the engine's `setHeadRpyDeg`. Used by manual
   * control surfaces like the camera-tab joystick; never used while
   * a conversation is active (the conversation owns the head via
   * its pose dispatcher).
   *
   * Returns `true` when the command was queued, `false` if the
   * engine isn't ready or the DC is down. Non-throwing.
   */
  setHeadRpyDeg: (rollDeg: number, pitchDeg: number, yawDeg: number) => boolean;
}

interface UseRobotSessionOptions {
  /** Central peer id of the robot the user picked upstream. */
  robotId: string;
  /** HF token, kept on the panel's session storage by upstream
   *  auth hook. Forwarded here so the engine can re-seed if it
   *  gets cleared mid-session. */
  token: string;
  /** Element onto which the engine writes audio-reactive CSS
   *  variables (the orb root). Read lazily when the level monitors
   *  spin up at conversation-start time, so it's fine for this ref
   *  to populate slightly after the hook mounts. */
  audioLevelsTargetRef: React.RefObject<HTMLElement | null>;
}

const TOOL_TOAST_MIN_MS = 1500;

export function useRobotSession({
  robotId,
  token,
  audioLevelsTargetRef,
}: UseRobotSessionOptions): RobotSessionHandle {
  const handleRef = useRef<ConversationEngineHandle | null>(null);
  // Used for StrictMode-safe mount: a fast remount could race with
  // the previous engine's teardown if we didn't gate on a per-mount
  // cancel token.
  const cancelTokenRef = useRef<{ cancelled: boolean } | null>(null);

  const [engineState, setEngineState] = useState<AppState>('signed-out');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [toolToastLabel, setToolToastLabel] = useState<string | null>(null);
  const [hasReachedReady, setHasReachedReady] = useState(false);
  const [connectionAttempt, setConnectionAttempt] =
    useState<ConversationConnectionAttempt | null>(null);
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

  // Sticky `hasReachedReady` latch. We flip on the first `ready`-or-
  // further state. Stays true through a release+reacquire cycle so
  // the host doesn't replay the connecting overlay every time. Reset
  // explicitly inside `tearDown()` so the next session starts fresh.
  useEffect(() => {
    if (hasReachedReady) return;
    if (
      engineState === 'ready' ||
      engineState === 'listening' ||
      engineState === 'user-speaking' ||
      engineState === 'processing' ||
      engineState === 'ai-speaking'
    ) {
      setHasReachedReady(true);
    }
  }, [engineState, hasReachedReady]);

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
        // Pass a *getter*, not `audioLevelsTargetRef.current`: the
        // orb DOM may be unmounted/remounted while the engine
        // stays alive (tab switches between Conv ↔ Apps, iframe
        // release/reacquire). The engine re-reads this on every
        // audio frame so its CSS-var writes always hit the
        // currently-mounted orb instead of an old detached node.
        audioLevelsTarget: () => audioLevelsTargetRef.current,
        onStateChange: (state) => {
          if (cancelToken.cancelled) return;
          setEngineState(state);
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
    }
  }, []);

  const attachVideo = useCallback((el: HTMLVideoElement): (() => void) => {
    const handle = handleRef.current;
    if (!handle) return () => {};
    return handle.attachVideo(el);
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

  const setHeadRpyDeg = useCallback(
    (rollDeg: number, pitchDeg: number, yawDeg: number): boolean => {
      return (
        handleRef.current?.setHeadRpyDeg(rollDeg, pitchDeg, yawDeg) ?? false
      );
    },
    [],
  );

  const phase = derivePhase(engineState, phaseHint);

  return {
    phase,
    engineState,
    errorMessage,
    micMuted,
    toolToastLabel,
    hasReachedReady,
    connectionAttempt,
    startConversation,
    stopConversation,
    triggerOrbAction,
    setMicMuted: setMicMutedCmd,
    requestStop,
    releaseForHandoff,
    reacquire,
    tearDown,
    attachVideo,
    getSpeakerVolume,
    setSpeakerVolume,
    getMicrophoneVolume,
    setMicrophoneVolume,
    getDaemonVersion,
    getMicLevel,
    playSound,
    setHeadRpyDeg,
  };
}
