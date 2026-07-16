/**
 * Engine-facing TypeScript surface for the ReachyMini SDK.
 *
 * The SDK is bundled via the npm package
 * `@pollen-robotics/reachy-mini-sdk` (see `sdk-bootstrap.ts` for the
 * `window.ReachyMini` shim). Its own `.d.ts` ships alongside the
 * runtime in the npm tarball and declares the public surface; the
 * interface below is the engine's superset — it adds the
 * runtime-only fields and aliases the engine actually consumes
 * (`_pc`, `attachVideo`, `setMicMuted`, `sendRaw`, ...).
 */

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
   * Exposed by the SDK as an internal field but used by the webrtc_example
   * reference to pull stats; we read it to get the audio receiver/senders.
   */
  _pc: RTCPeerConnection | null;

  authenticate(): Promise<boolean>;
  login(): Promise<void>;
  logout(): void;

  connect(token?: string): Promise<void>;
  disconnect(): void;

  startSession(robotId: string): Promise<void>;
  stopSession(): Promise<void>;

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
  playRecordedMove(moveName: string, opts?: { dataset?: string }): boolean;

  /**
   * Play the wake-up trajectory (head + antennas, ~2 s) AND power
   * the motors on. The post-PR-1085 SDK returns a Promise that
   * resolves on the daemon's `completed: true` ack, with optional
   * `timeoutMs` to bound the wait.
   */
  wakeUp(options?: { timeoutMs?: number }): Promise<void>;

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
