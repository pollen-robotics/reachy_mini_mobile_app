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
  playSound(file: string): boolean;

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
   * Apply a batch of XVF3800 audio-board parameters via the
   * daemon's `apply_audio_config` command. Same data-channel
   * round-trip as the volume helpers, with optional verification
   * read-back per parameter.
   *
   * Marked optional because the method was added in upstream
   * Reachy Mini PR #1134; older bundled SDK builds don't expose
   * it. Callers should feature-detect with
   * `typeof robot.applyAudioConfig === 'function'` before invoking
   * - see `features/conversation/audio/startup-config.ts` for the
   * conversation-app helper that does exactly that.
   *
   * Resolves to `true` when every parameter was written (and,
   * when `verify=true`, read back successfully), `false` when the
   * audio board is unavailable, the daemon errored, or the data
   * channel is down.
   */
  applyAudioConfig?(
    config: readonly { name: string; values: readonly number[] }[],
    options?: { verify?: boolean },
  ): Promise<boolean>;

  /**
   * Read a single XVF3800 parameter by name. Counterpart of
   * `applyAudioConfig`; same optional-method caveat (only present
   * on the post-PR-1134 SDK).
   *
   * Resolves to the decoded numeric values, or `null` when the
   * parameter is unknown / unreadable / the audio board is
   * unavailable.
   */
  readAudioParameter?(name: string): Promise<readonly number[] | null>;

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
