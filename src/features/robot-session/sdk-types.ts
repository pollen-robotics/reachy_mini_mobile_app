/**
 * Type declarations for the ReachyMini SDK loaded from a CDN script tag in
 * index.html. We only expose what we actually consume here.
 *
 * The SDK is an `EventTarget`; listeners are wired via `addEventListener`.
 * The events the mobile shell consumes are:
 *
 *   - `robotsChanged`    { robots: RobotInfo[] }
 *   - `sessionStopped`   { reason: string }
 *   - `videoTrack`       { track: MediaStreamTrack; stream: MediaStream }
 *   - `disconnected`     { reason: string }
 *   - `error`            { source: 'signaling' | 'webrtc' | 'robot'; error: Error | string }
 *
 * Resilience events (added in the SDK's grace + network awareness pass —
 * see `vendor/reachy-mini.js` for the full payloads):
 *
 *   - `iceStateChange`   { state: RTCIceConnectionState }
 *                          Fires on every PC ICE transition. `disconnected`
 *                          and `failed` are debounced internally before
 *                          escalating to `error`.
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
 * We intentionally don't strong-type these via `addEventListener`
 * overloads: the SDK is a runtime-loaded vendored bundle, and the
 * `CustomEvent<…>` casts at call sites stay readable without an
 * extra layer of declaration merging. If/when the SDK is published
 * as a typed package, this is the natural place to upgrade.
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
