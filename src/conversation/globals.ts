/**
 * Type declarations for the ReachyMini SDK loaded from a CDN script tag in
 * index.html. We only expose what we actually consume here.
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

  setHeadPose(roll: number, pitch: number, yaw: number): boolean;
  setAntennas(right: number, left: number): boolean;
  playSound(file: string): boolean;

  /**
   * Play the wake-up trajectory (head + antennas, ~2 s) AND power the
   * motors on. Fire-and-forget over the WebRTC data channel: returns
   * `false` if the channel isn't open yet.
   */
  wakeUp(): boolean;

  /**
   * Play the goto-sleep trajectory and release motor torque at the
   * end. Fire-and-forget, same semantics as `wakeUp`. Call this
   * *before* `stopSession()` so the command reaches the daemon while
   * the data channel is still live.
   */
  gotoSleep(): boolean;

  /**
   * Send an arbitrary JSON message on the robot data channel. Useful for
   * wire-format commands not exposed by dedicated helpers (e.g.
   * `set_full_target` to stream dance frames).
   */
  sendRaw(data: unknown): boolean;

  setAudioMuted(muted: boolean): void;
  setMicMuted(muted: boolean): void;
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
