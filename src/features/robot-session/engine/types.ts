/**
 * Public types exposed by the session engine.
 *
 * Lifted out of `session-engine.ts` so the host (React screens, the
 * session hook) can import them without dragging in the engine's
 * implementation. The runtime entrypoint (`mountSessionEngine`) and
 * the engine internals stay in `session-engine.ts`.
 *
 * The conversation itself (AI pipeline) runs ON THE ROBOT now — the
 * phone drives it over the DataChannel via JSON-RPC (`rpcCall` /
 * `onNotification`, see `features/conv-app`). This engine only owns
 * the transport: SDK connect, WebRTC session, wake/sleep, release /
 * reacquire, and the SDK pass-throughs.
 */

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';
import type { TransportInfo } from '@/features/robot-session/transport-monitor';

/**
 * Connection (transport) state machine.
 *
 * Owns the lifecycle of the SDK / WebRTC / DataChannel link to the
 * robot - the "is a robot physically reachable" question.
 *
 * Hoisted to its own module so the React watchdog, the phase derivation
 * and the `onConnectionStateChange` observer can pattern-match on it
 * without duplicating the union.
 */
export type ConnectionState =
  | 'signed-out'
  | 'authenticated'
  | 'connecting'
  | 'connected'
  | 'selecting'
  | 'starting'
  /**
   * SDK + WebRTC + DataChannel are up, the wake-up trajectory has
   * been kicked off, motors are enabled - the robot is physically
   * "online". `live` is its own state (rather than reusing
   * `connected`) because `connected` is the transient handshake
   * state, whereas `live` is a stable parking state.
   */
  | 'live'
  /**
   * Session was deliberately released for a handoff (e.g. an embedded
   * iframe app needs the robot's WebRTC peer slot). HF auth + SSE are
   * still up, the robot is still PHYSICALLY awake, but
   * `robot.stopSession()` has fired and central no longer routes us to
   * the robot. A subsequent `reacquireSession()` brings the WebRTC
   * tunnel back without going through the wake-up dance.
   */
  | 'released'
  | 'error';

/**
 * Per-attempt info emitted while `doStart` runs through its
 * connection-retry loop.
 *
 * Fired:
 *   - At the start of every attempt (so the host can update the
 *     connecting overlay if `attempt > 1`).
 *   - With `null` when we either succeed or give up (the host
 *     should clear any "retrying" hint at that point).
 *
 * The robot's daemon has a known intermittent failure mode where
 * libnice asserts inside the WebRTC ICE nomination, kills the daemon
 * outright, and systemd takes ~13-16 s to bring it back up. The retry
 * loop survives that crash; the host shows "Reconnecting… (n of m)"
 * so the user understands we're actively working on it.
 */
export interface ConnectionAttempt {
  /** 1-indexed. `1` is the first attempt, `2` is the first retry. */
  attempt: number;
  /** Total number of attempts the engine will make before giving up. */
  maxAttempts: number;
}

export interface SessionEngineHandle {
  /** Tear down all listeners and WebRTC peer connections. Safe to
   *  call multiple times. */
  unmount: () => Promise<void>;
  /**
   * Hand the robot off to another consumer (typically an embedded
   * HF Space app rendered in an iframe) WITHOUT putting it to sleep.
   * Robot stays physically awake, HF auth / SSE stay open. State
   * machine parks in `released`.
   */
  releaseSessionKeepAwake: () => Promise<void>;
  /**
   * Bring the WebRTC session back up after a previous
   * `releaseSessionKeepAwake()`. Skips wake-up + motor-enable
   * because the robot was kept awake during the handoff.
   */
  reacquireSession: () => Promise<void>;

  // ─── Audio volume controls ────────────────────────────────────────
  // Thin pass-throughs to the SDK's DataChannel round-trips. All
  // resolve `null` when the platform has no volume control or the
  // SDK isn't ready. Non-throwing.

  getSpeakerVolume: () => Promise<number | null>;
  setSpeakerVolume: (volume: number) => Promise<number | null>;
  getMicrophoneVolume: () => Promise<number | null>;
  setMicrophoneVolume: (volume: number) => Promise<number | null>;

  /** Read the daemon's reported version string. `null` when the DC
   *  isn't open or the daemon predates `get_version`. Non-throwing. */
  getDaemonVersion: () => Promise<string | null>;

  /** Trigger a daemon self-update over the data channel. Returns
   *  `false` when the channel isn't open. Non-throwing. */
  startDaemonUpdate: (options?: { preRelease?: boolean }) => boolean;

  /** Play a bundled sound file on the robot's speaker. Returns `true`
   *  when queued onto the DataChannel. Non-throwing. */
  playSound: (file: string) => boolean;

  /** Subscribe to the daemon's journalctl stream over the data
   *  channel. Returns an `unsubscribe()` safe to call repeatedly. */
  subscribeLogs: (options: {
    onLine: (entry: { timestamp: string; line: string }) => void;
    onError?: (error: string) => void;
  }) => () => void;

  /** Raw SDK instance accessor, or `null` when the engine isn't live. */
  getRobot: () => ReachyMiniInstance | null;

  /** Bind the robot's video stream to a `<video>` element, replaying
   *  the cached track if it already arrived. Returns a detach callback. */
  attachVideo: (videoElement: HTMLVideoElement) => () => void;
}

export interface SessionEngineOptions {
  /**
   * Peer id the mobile app already knows for the specific Reachy the
   * user picked on the ScanScreen (from the central robot list).
   * When set, the engine auto-connects and drives straight into
   * `startSession` instead of waiting on `robotsChanged`.
   */
  preselectedRobotId?: string | null;

  /**
   * Gate consulted right before the bring-up wakes the robot. When it
   * returns `true`, the engine SKIPS the initial wake-up and reaches
   * `live` with the robot still asleep, leaving the very first
   * `wakeUp()` to the host's first-wake-up wizard.
   */
  shouldDeferInitialWakeUp?: () => boolean;

  /** Fires on every connection transition (`signed-out` → `connecting`
   *  → `starting` → `live` → …). */
  onConnectionStateChange?: (state: ConnectionState) => void;

  /**
   * Daemon version resolved as part of the connection bring-up:
   * emitted once, just before the connection flips to `live`. `null`
   * means the read timed out / the daemon doesn't expose a version.
   */
  onDaemonVersionChange?: (version: string | null) => void;

  /** Live snapshot of the WebRTC transport (ICE pair kind + bitrate +
   *  RTT). See `TransportMonitor`. */
  onTransportChange?: (info: TransportInfo) => void;

  /** User-facing error caption (null clears it). */
  onErrorMessageChange?: (message: string | null) => void;

  /** Per-attempt progress of the connection-retry loop. */
  onConnectionAttempt?: (attempt: ConnectionAttempt | null) => void;
}
