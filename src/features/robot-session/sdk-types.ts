/**
 * Engine-facing TypeScript surface for the ReachyMini SDK.
 *
 * The SDK is bundled via the npm package
 * `@pollen-robotics/reachy-mini-sdk` (see `sdk-bootstrap.ts` for the
 * `window.ReachyMini` shim). Its own `.d.ts` ships alongside the
 * runtime in the npm tarball and declares the public surface; the
 * interface below is the engine's superset — it adds the
 * runtime-only fields and aliases the engine actually consumes
 * (`peerConnection`, `attachVideo`, `setMicMuted`, `sendRaw`, ...).
 *
 * The SDK is an `EventTarget`; listeners are wired via
 * `addEventListener`. The events the mobile shell consumes are:
 *
 *   - `robotsChanged`    { robots: RobotInfo[] }
 *   - `sessionStopped`   { reason: string }
 *   - `videoTrack`       { track: MediaStreamTrack; stream: MediaStream }
 *   - `disconnected`     { reason: string }
 *   - `error`            { source: 'signaling' | 'webrtc' | 'robot';
 *                          error: Error | string }
 *
 * Resilience events (added in the SDK's ICE-grace + network-awareness
 * pass, see `reachy-mini.ts` in the SDK for the full payloads):
 *
 *   - `iceStateChange`   { state: RTCIceConnectionState }
 *                          Fires on every PC ICE transition.
 *                          `disconnected` and `failed` are debounced
 *                          internally before escalating to `error`.
 *   - `networkOnline`    {}    forwarded from `window.online`
 *   - `networkOffline`   {}    forwarded from `window.offline`
 *   - `networkChange`    { effectiveType?: string; downlink?: number;
 *                          rtt?: number; saveData?: boolean }
 *                          forwarded from `navigator.connection.change`
 *                          on engines that ship NetworkInformation
 *                          (Chrome / Android WebView; absent on Safari /
 *                          iOS WKWebView, which is why we *also* listen
 *                          to `online`/`offline`).
 *
 * Auto re-dial events (SDK `autoReconnect: true`, see
 * `_runRedialLoop` in the SDK):
 *
 *   - `sessionReconnecting` { attempt: number; maxAttempts: number;
 *                             cause: string }
 *                             One per re-dial attempt. The old
 *                             transport is already torn down.
 *   - `sessionReconnected`  { attempt: number }
 *                             Re-dial succeeded: fresh PC + DC, a new
 *                             `videoTrack` fires alongside. Daemon-side
 *                             per-session state (motor mode, pose
 *                             subscription) must be re-asserted by us.
 *
 * We intentionally don't strong-type these via `addEventListener`
 * overloads: the payloads reach us as `CustomEvent<…>` casts at the
 * few call sites (`robot-events.ts`), which stays readable without an
 * extra layer of declaration merging.
 */

/**
 * Max robot display-name length enforced by the UI. Single source of truth for
 * both naming surfaces - the first wake-up wizard's name step and the
 * conversation settings rename field - so the two can't drift. The daemon also
 * trims/caps server-side, so this is a UX guard, not the authority.
 */
export const MAX_ROBOT_NAME_LENGTH = 64;

export interface RobotInfo {
  id: string;
  meta?: { name?: string };
}

export interface RobotState {
  head: { roll: number; pitch: number; yaw: number };
  antennas: { right: number; left: number };
}

export interface ReachyMiniOptions {
  signalingUrl?: string;
  enableMicrophone?: boolean;
  clientId?: string;
  appName?: string;
  /**
   * Enable the SDK's automatic session re-dial: when an ESTABLISHED
   * session's transport dies (ICE failure past the grace window,
   * network loss), the SDK tears the WebRTC leg down and retries
   * `startSession` with backoff instead of emitting a fatal error.
   * Emits `sessionReconnecting` per attempt and `sessionReconnected`
   * on success; a terminal give-up falls back to `sessionStopped`.
   */
  autoReconnect?: boolean;
}

export interface ReachyMiniInstance extends EventTarget {
  readonly state: "disconnected" | "connected" | "streaming";
  readonly robots: RobotInfo[];
  readonly username: string | null;
  readonly isAuthenticated: boolean;
  readonly micSupported: boolean;
  readonly micMuted: boolean;
  readonly audioMuted: boolean;

  /**
   * Underlying RTCPeerConnection; we read it to get the audio
   * receivers/senders. Auto-reconnect re-dials REPLACE this object, so
   * re-read it on every use - never capture it across ticks.
   */
  readonly peerConnection: RTCPeerConnection | null;

  /**
   * Latest robot telemetry mirrored by the SDK from `state` events. Only as
   * fresh as the last state received: hold a `subscribePose()` while you need
   * `head` to be current (see `DaemonHeadControl`'s tracking handoff).
   * `head` is the flat row-major 4x4 head pose (16 numbers).
   */
  readonly robotState: {
    head?: number[];
    antennas?: number[];
    head_joint_positions?: number[];
    /** Body yaw in radians. */
    body_yaw?: number;
    motor_mode?: string;
  };

  authenticate(): Promise<boolean>;
  login(): Promise<void>;
  logout(): void;

  connect(token?: string): Promise<void>;
  disconnect(): void;

  startSession(robotId: string): Promise<void>;
  stopSession(): Promise<void>;

  /**
   * Toggle the SDK's automatic session re-dial at runtime (see the
   * `autoReconnect` constructor option). Disabling cancels any
   * in-flight re-dial loop. Optional: absent on SDK builds that
   * predate the auto-reconnect pass.
   */
  setAutoReconnect?(enabled: boolean): void;

  attachVideo(el: HTMLVideoElement): () => void;

  /** Set head orientation from roll/pitch/yaw in degrees. */
  setHeadRpyDeg(roll: number, pitch: number, yaw: number): boolean;
  /** Set antennas from right/left positions in degrees. */
  setAntennasDeg(right: number, left: number): boolean;
  /**
   * Set the body yaw target in degrees (absolute, around the
   * vertical axis). The daemon's analytical kinematics caps body
   * yaw at ±160° mechanically; callers should clamp client-side
   * to stay within a safe margin (the camera-tab joystick uses
   * ±150°).
   */
  setBodyYawDeg(yawDeg: number): boolean;
  /**
   * One `set_full_target` frame carrying any subset of head (flat
   * row-major 4x4), antennas ([right, left] rad) and body yaw (rad).
   * Sending head + body together keeps them consistent for the daemon's
   * head-vs-body yaw check. Returns false when the channel is closed.
   */
  setTarget(target: { head?: number[]; antennas?: number[]; body_yaw?: number }): boolean;

  /**
   * Smoothly interpolate to a target pose ENTIRELY daemon-side: the robot
   * runs the goto at 100 Hz locally, so it's immune to data-channel jitter
   * (unlike streaming `set_full_target` frames one by one, which judder over
   * Wi-Fi). Goes through the daemon's move player, so it's a no-op while
   * another move is still running (`is_move_running`). Fire-and-forget:
   * returns `true` once sent on the data channel, `false` if it's closed.
   * `head` is a flat 16-element row-major 4x4 matrix, `antennas` is
   * `[rightRad, leftRad]`, `duration` is in seconds.
   */
  gotoTarget(opts: {
    head?: number[];
    antennas?: number[];
    body_yaw?: number;
    duration: number;
  }): boolean;

  /** Ask the daemon for a one-shot state snapshot (fires a `state` event). */
  requestState(): boolean;

  /**
   * Subscribe/unsubscribe to the daemon's ~30 Hz pushed pose stream (fired as
   * `state` events) over the dedicated unreliable/unordered `pose` channel -
   * immune to the Wi-Fi round-trip lag of polling `requestState`. Refcounted in
   * the SDK, so pair each `subscribePose()` with one `unsubscribePose()`;
   * multiple consumers share one daemon-side subscription. No-op against a
   * daemon that predates the pose channel.
   */
  subscribePose(): boolean;
  unsubscribePose(): boolean;

  playSound(file: string): boolean;

  /**
   * Play a named recorded move (motion + its bundled sound) from a HF dataset,
   * daemon-side. Fire-and-forget: returns `true` once sent on the data channel
   * (not when playback finishes), `false` if the channel is closed. `dataset`
   * defaults to the robot's pre-downloaded emotions library
   * (`pollen-robotics/reachy-mini-emotions-library`).
   */
  playRecordedMove(
    moveName: string,
    opts?: { dataset?: string; initialGotoDuration?: number },
  ): boolean;

  /**
   * Ask the daemon to pre-download a recorded-move dataset into its local HF
   * cache so a later `playRecordedMove` from it starts instantly. The daemon
   * only preloads the official pollen-robotics libraries by itself - any
   * app-specific dataset (e.g. the onboarding moves) is our job to warm at
   * session start. Fire-and-forget + idempotent (cache-first daemon-side);
   * on failure `playRecordedMove` still downloads on demand. Optional
   * because a daemon older than the command simply won't have it.
   */
  preloadDataset?(dataset: string): boolean;

  /**
   * Like `preloadDataset`, but resolves once the daemon acks the preload,
   * i.e. when the dataset is actually in the robot's local HF cache.
   * Resolves `true` on success, `false` on a daemon-reported download
   * failure, `null` on the SDK's fail-open timeout (slow download, or a
   * daemon that predates the command and never replies). Rejects when the
   * data channel isn't open or the session tears down mid-flight. Optional
   * because an SDK build older than the awaited variant won't have it.
   */
  preloadDatasetAndWait?(
    dataset: string,
    options?: { timeoutMs?: number },
  ): Promise<boolean | null>;

  /**
   * Stop whatever move is currently playing on the daemon (recorded move,
   * uploaded move, goto), silencing its bundled sound too. Fire-and-forget
   * and idempotent: a stop with no move running is acked as a no-op, not an
   * error. Returns `false` if the data channel is not open. Optional because
   * a daemon/SDK older than the command simply won't have it.
   */
  stopMove?(): boolean;

  /**
   * Play the wake-up trajectory (head + antennas, ~2 s) AND power
   * the motors on. The post-PR-1085 SDK returns a Promise that
   * resolves on the daemon's `completed: true` ack, with optional
   * `timeoutMs` to bound the wait.
   */
  wakeUp(options?: { timeoutMs?: number }): Promise<void>;

  /** Cached motor-mode check: `enabled` or `gravity_compensation`
   *  count as awake. Synchronous, reads the SDK's state mirror. */
  isAwake(): boolean;

  /**
   * Idempotent wake (SDK >= feat/sdk-js-core): no-op when already
   * under position control, flips `gravity_compensation` back to
   * `enabled` without replaying the emote, and otherwise plays the
   * wake trajectory AWAITED to completion (internal ~5 s budget).
   * Never rejects on a wake failure - always resolves `true` once
   * the robot is as awake as it's going to get.
   */
  ensureAwake(timeoutMs?: number): Promise<boolean>;

  /**
   * Play the goto-sleep trajectory and release motor torque at the
   * end. Same async/Promise semantics as `wakeUp`. Call this
   * *before* `stopSession()` so the command reaches the daemon
   * while the data channel is still live.
   */
  gotoSleep(options?: { timeoutMs?: number }): Promise<void>;

  /**
   * Set the motor control mode synchronously over the data channel.
   * Returns `false` if the channel isn't open yet (the daemon side
   * is fire-and-forget). Use this AFTER `gotoSleep` resolves to
   * deterministically release torque on disconnect.
   */
  setMotorMode(mode: 'enabled' | 'disabled' | 'gravity_compensation'): boolean;

  /**
   * Send an arbitrary JSON message on the robot data channel. Useful for
   * wire-format commands not exposed by dedicated helpers (e.g.
   * `set_full_target` to stream dance frames).
   */
  sendRaw(data: unknown): boolean;

  /**
   * Generic round-trip for daemon commands without a typed wrapper: sends
   * `command` and resolves with the first robot message whose `command`
   * field equals `command.type`, or `null` on timeout (daemon predates the
   * command). Rejects when the data channel isn't open.
   */
  request(
    command: { type: string } & Record<string, unknown>,
    options?: { timeoutMs?: number; match?: (msg: Record<string, unknown>) => boolean },
  ): Promise<Record<string, unknown> | null>;

  /**
   * Sign this robot out of Hugging Face over the data channel: the daemon
   * deletes its stored HF token and de-registers from central, so the
   * robot disappears from its owner's list until it's set up again.
   * Resolves `true` on daemon-acked success, `false` on a daemon error,
   * or `null` when the channel isn't open / the daemon predates the
   * command. The sign-out drops the central relay, so the session may
   * tear down right after the ack - treat a post-call drop as expected.
   */
  signOut(): Promise<boolean | null>;

  /**
   * Read the robot's persisted display name over the data channel (the
   * string advertised to central / mDNS and shown in the robot list).
   * Resolves `null` when unset, the channel isn't open, or the daemon
   * predates the `get_robot_name` command.
   */
  getRobotName(): Promise<string | null>;

  /**
   * Persist a new robot display name over the data channel. Resolves with
   * the daemon's stored (trimmed, length-capped) name on success, or `null`
   * on a daemon error / closed channel / unsupported daemon. The rename is
   * stored on the robot and applied live (status + central relay + mDNS), so
   * it takes effect right away without a daemon restart.
   */
  setRobotName(name: string): Promise<string | null>;

  /**
   * Read the robot's persisted "first wake-up wizard completed" flag over
   * the data channel. Resolves `false` when pending, `true` when done, or
   * `null` when the channel isn't open / the daemon predates the
   * `get_first_wake_up` command. Callers should fail-open (skip the wizard)
   * on `null`.
   */
  getFirstWakeUp(): Promise<boolean | null>;

  /**
   * Persist the first wake-up wizard completion flag on the robot so the
   * wizard only ever runs once. Resolves with the stored value, or `null`
   * on a daemon error / closed channel / unsupported daemon.
   */
  setFirstWakeUp(isCompleted: boolean): Promise<boolean | null>;

  setAudioMuted(muted: boolean): void;
  setMicMuted(muted: boolean): void;

  /**
   * Speaker volume on the robot. Both methods round-trip on the
   * data channel and resolve with the daemon's authoritative value
   * (or `null` on timeout / channel-closed).
   */
  getVolume(): Promise<number | null>;
  setVolume(volume: number): Promise<number | null>;

  /**
   * On-robot microphone volume. Same data-channel round-trip
   * semantics as the speaker volume getters.
   */
  getMicrophoneVolume(): Promise<number | null>;
  setMicrophoneVolume(volume: number): Promise<number | null>;

  /**
   * XVF3800 audio-board batch tuning (Wireless only). Resolves
   * `true` on full success; `false` when the board is absent
   * (Lite / dev) or any write/verify failed. Never throws.
   * Mirrors the on-robot `AudioBase.apply_audio_config()` SDK.
   */
  applyAudioConfig(
    config: ReadonlyArray<{ name: string; values: number[] }>,
    options?: { verify?: boolean },
  ): Promise<boolean>;

  /**
   * Read a single XVF3800 parameter by name. `null` when the
   * parameter is unknown or the audio board is unavailable.
   */
  readAudioParameter(name: string): Promise<number[] | null>;

  /**
   * Daemon version string (e.g. `"1.5.1"`), one-shot over the data
   * channel. Resolves to `null` when the channel isn't open or the
   * daemon predates the `get_version` Cmd.
   */
  getVersion(): Promise<string | null>;

  /**
   * Subscribe to the daemon's `journalctl -u reachy-mini-daemon`
   * stream over the WebRTC data channel. One daemon-side subprocess
   * is shared across local subscribers (first add sends
   * `subscribe_logs`, last removal sends `unsubscribe_logs`).
   *
   * Returns an `unsubscribe()` function that's safe to call more
   * than once. `onError` is invoked when the daemon reports a
   * `log_stream_error` (e.g. `journalctl` not available on
   * dev/macOS).
   */
  subscribeLogs(options: {
    onLine: (entry: { timestamp: string; line: string }) => void;
    onError?: (error: string) => void;
  }): () => void;
}

export type ReachyMiniConstructor = new (
  options?: ReachyMiniOptions,
) => ReachyMiniInstance;

declare global {
  interface Window {
    ReachyMini: ReachyMiniConstructor;
  }
}

export {};
