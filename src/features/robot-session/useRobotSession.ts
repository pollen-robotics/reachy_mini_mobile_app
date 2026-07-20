/**
 * Robot session hook.
 *
 * Single source of truth for the robot connect / disconnect lifecycle.
 * The hook owns the session-engine handle and exposes session-level
 * commands to the host:
 *
 *   - `releaseForHandoff()`  release the WebRTC session for an
 *                            iframe handoff. The robot stays awake;
 *                            the embed can dial in.
 *   - `reacquire()`          bring the WebRTC session back up
 *                            after a release, without re-running
 *                            the wake-up dance.
 *   - `tearDown()`           full teardown (gotoSleep + motors
 *                            disabled + stopSession + disconnect).
 *
 * The AI conversation runs ON THE ROBOT (the daemon launches the
 * conversation app; the phone drives it over JSON-RPC on the
 * DataChannel — see `features/conv-app`), so this hook only models
 * the transport.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { chainLifecycle } from '@/features/robot-session/lifecycle-queue';
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';
import type { TransportInfo } from '@/features/robot-session/transport-monitor';
import {
  mountSessionEngine,
  type ConnectionState,
  type ConnectionAttempt,
  type SessionEngineHandle,
} from '@/features/robot-session/engine/session-engine';

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
  /** Last fatal error message surfaced by the engine, or null. */
  errorMessage: string | null;
  /** Whether the engine has reached `live` at least once on the
   *  current session. Sticky: stays true through releases /
   *  re-acquires until `tearDown()` resets it. */
  hasReachedReady: boolean;
  /**
   * In-flight connection-retry info, or `null` when no retry is
   * happening. The host shows a "Reconnecting… (n of m)" caption
   * inside the connecting overlay when this is non-null AND
   * `attempt > 1`.
   */
  connectionAttempt: ConnectionAttempt | null;
  /**
   * Live snapshot of the WebRTC transport used by the peer
   * connection: ICE candidate-pair classification (`lan` / `direct`
   * / `relay`) + instantaneous bitrate + RTT.
   *
   * `null` when no value has been observed yet. Freezes at its last
   * value while the session is up; cleared on teardown/release.
   */
  webrtcTransport: TransportInfo | null;
  /**
   * Daemon version resolved as part of the connection bring-up
   * (emitted just before the connection reaches `live`), or `null`
   * when unknown. Source of truth for the update gate.
   */
  daemonVersion: string | null;

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
   * When the engine isn't mounted yet, returns a noop unsubscribe;
   * consumers are expected to re-call this every time the session
   * reaches `ready` (typically inside a `useEffect` keyed on
   * `hasReachedReady`).
   */
  subscribeLogs: (options: {
    onLine: (entry: { timestamp: string; line: string }) => void;
    onError?: (error: string) => void;
  }) => () => void;

  /**
   * Raw SDK instance accessor, or `null` when no session is live.
   * Low-level escape hatch (reading the robot mic track off `_pc`,
   * JSON-RPC via `rpcCall`, replaying the wake-up trajectory). Most
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
  /** Central peer id of the robot the user picked upstream. */
  robotId: string;
  /** HF token, kept on the panel's session storage by upstream
   *  auth hook. Forwarded here so the engine can re-seed if it
   *  gets cleared mid-session. */
  token: string;
  /** Bring-up gate: when it returns true, the engine defers the initial
   *  wake-up to the host so the first-wake-up wizard's motor step owns
   *  the very first `wakeUp()`. Evaluated fresh on every bring-up (read
   *  through a ref), so the host can flip it between sessions. */
  shouldDeferInitialWakeUp?: () => boolean;
}

export function useRobotSession({
  robotId,
  token,
  shouldDeferInitialWakeUp,
}: UseRobotSessionOptions): RobotSessionHandle {
  const handleRef = useRef<SessionEngineHandle | null>(null);
  // Keep the latest host getter in a ref so the engine (mounted once per
  // `robotId`) always reads the current value at bring-up instead of the
  // closure captured on first render.
  const shouldDeferInitialWakeUpRef = useRef(shouldDeferInitialWakeUp);
  shouldDeferInitialWakeUpRef.current = shouldDeferInitialWakeUp;
  // Used for StrictMode-safe mount: a fast remount could race with
  // the previous engine's teardown if we didn't gate on a per-mount
  // cancel token.
  const cancelTokenRef = useRef<{ cancelled: boolean } | null>(null);

  const [connectionState, setConnectionState] = useState<ConnectionState>('signed-out');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasReachedReady, setHasReachedReady] = useState(false);
  const [daemonVersion, setDaemonVersion] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState<ConnectionAttempt | null>(null);
  const [webrtcTransport, setWebrtcTransport] = useState<TransportInfo | null>(null);
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
    let mountedHandle: SessionEngineHandle | null = null;

    void chainLifecycle(async () => {
      if (cancelToken.cancelled) return;
      const handle = mountSessionEngine({
        preselectedRobotId: robotId,
        // Read through the ref so the engine always sees the host's
        // current first-wake-up decision, not the one at mount time.
        shouldDeferInitialWakeUp: () => shouldDeferInitialWakeUpRef.current?.() ?? false,
        onConnectionStateChange: state => {
          if (cancelToken.cancelled) return;
          setConnectionState(state);
        },
        onErrorMessageChange: message => {
          if (cancelToken.cancelled) return;
          setErrorMessage(message);
        },
        onConnectionAttempt: info => {
          if (cancelToken.cancelled) return;
          setConnectionAttempt(info);
        },
        onDaemonVersionChange: version => {
          if (cancelToken.cancelled) return;
          setDaemonVersion(version);
        },
        onTransportChange: info => {
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
  }, [robotId]);

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

  const setSpeakerVolume = useCallback(async (volume: number): Promise<number | null> => {
    return handleRef.current?.setSpeakerVolume(volume) ?? Promise.resolve(null);
  }, []);

  const getMicrophoneVolume = useCallback(async (): Promise<number | null> => {
    return handleRef.current?.getMicrophoneVolume() ?? Promise.resolve(null);
  }, []);

  const setMicrophoneVolume = useCallback(async (volume: number): Promise<number | null> => {
    return handleRef.current?.setMicrophoneVolume(volume) ?? Promise.resolve(null);
  }, []);

  const getDaemonVersion = useCallback(async (): Promise<string | null> => {
    return handleRef.current?.getDaemonVersion() ?? Promise.resolve(null);
  }, []);

  const startDaemonUpdate = useCallback((options?: { preRelease?: boolean }): boolean => {
    return handleRef.current?.startDaemonUpdate(options) ?? false;
  }, []);

  const playSound = useCallback((file: string): boolean => {
    return handleRef.current?.playSound(file) ?? false;
  }, []);

  const getRobot = useCallback((): ReachyMiniInstance | null => {
    return handleRef.current?.getRobot() ?? null;
  }, []);

  const attachVideo = useCallback((videoElement: HTMLVideoElement): (() => void) => {
    return handleRef.current?.attachVideo(videoElement) ?? (() => {});
  }, []);

  const subscribeLogs = useCallback<RobotSessionHandle['subscribeLogs']>(options => {
    const handle = handleRef.current;
    if (!handle) return () => {};
    return handle.subscribeLogs(options);
  }, []);

  const phase = derivePhase(connectionState, phaseHint);

  return {
    phase,
    connectionState,
    errorMessage,
    hasReachedReady,
    daemonVersion,
    connectionAttempt,
    webrtcTransport,
    releaseForHandoff,
    reacquire,
    tearDown,
    getSpeakerVolume,
    setSpeakerVolume,
    getMicrophoneVolume,
    setMicrophoneVolume,
    getDaemonVersion,
    startDaemonUpdate,
    playSound,
    subscribeLogs,
    getRobot,
    attachVideo,
  };
}
