/**
 * Ambient type declarations for `@pollen-robotics/reachy-mini-sdk`.
 *
 * The published npm package ships plain JavaScript with no bundled
 * `.d.ts`, so TypeScript would otherwise see the import as `any`.
 * Declare the subset of the SDK surface we actually call from the
 * mobile app. Keep in sync with the daemon SDK when adding fields —
 * the runtime is the source of truth (see `js/reachy-mini-sdk.js`
 * upstream in pollen-robotics/reachy_mini).
 */

declare module '@pollen-robotics/reachy-mini-sdk' {
  export interface ReachyMiniRobotInfo {
    id: string;
    meta: { name?: string; [k: string]: unknown };
  }

  export interface ReachyMiniOptions {
    signalingUrl?: string;
    enableMicrophone?: boolean;
    clientId?: string;
    appName?: string;
    videoJitterBufferTargetMs?: number;
  }

  export type ReachyMiniState = 'disconnected' | 'connected' | 'streaming';

  export type MotorMode = 'enabled' | 'disabled' | 'gravity_compensation';

  /**
   * Latest snapshot of the daemon-reported robot state. Fields appear
   * only once the corresponding source field has been observed at
   * least once - they may all be `undefined` right after `startSession()`
   * resolves but before the first `state` event lands.
   */
  export interface ReachyMiniRobotState {
    head?: number[];
    antennas?: number[];
    body_yaw?: number;
    motor_mode?: MotorMode;
    is_move_running?: boolean;
  }

  export class ReachyMini extends EventTarget {
    constructor(options?: ReachyMiniOptions);

    readonly state: ReachyMiniState;
    readonly robots: ReachyMiniRobotInfo[];
    readonly robotState: ReachyMiniRobotState;
    readonly username: string | null;
    readonly isAuthenticated: boolean;
    readonly micSupported: boolean;
    readonly micMuted: boolean;
    readonly audioMuted: boolean;

    authenticate(): Promise<boolean>;
    login(): Promise<void>;
    logout(): void;

    connect(token?: string): Promise<void>;
    disconnect(): void;

    startSession(robotId: string): Promise<void>;
    stopSession(): Promise<void>;

    setTarget(target: {
      head?: number[];
      antennas?: [number, number];
      body_yaw?: number;
    }): boolean;
    setHeadOrientation(rollDeg: number, pitchDeg: number, yawDeg: number): boolean;
    setHeadRpyDeg(rollDeg: number, pitchDeg: number, yawDeg: number): boolean;
    setAntennasDeg(rightDeg: number, leftDeg: number): boolean;
    setBodyYawDeg(yawDeg: number): boolean;

    setMotorMode(mode: MotorMode): void;

    /**
     * Play the wake-up animation and resolve when the daemon reports
     * completion (response carries `command: "wake_up", completed: true`).
     * Rejects on data-channel error, daemon error, timeout, or session
     * teardown.
     */
    wakeUp(options?: { timeoutMs?: number }): Promise<void>;

    /**
     * Play the goto-sleep animation and resolve when the daemon reports
     * completion. Same rejection semantics as `wakeUp`.
     *
     * Use this to safely chain a motor disable AFTER the trajectory has
     * landed in the sleep pose:
     *
     *   await robot.gotoSleep();
     *   robot.setMotorMode('disabled');
     */
    gotoSleep(options?: { timeoutMs?: number }): Promise<void>;

    /**
     * Ask the daemon to push a fresh `state` event right now. Useful
     * for telemetry; **do not** rely on the resulting `is_move_running`
     * to detect goto_sleep / wake_up completion - use the promise
     * returned by `gotoSleep()` / `wakeUp()` instead, which the daemon
     * resolves authoritatively after the trajectory player finishes.
     */
    requestState(): void;

    /**
     * Play one of the bundled sound files on the robot's speaker
     * (e.g. `"wake_up.wav"`, `"count.wav"`, `"impatient1.wav"`).
     * Sends a `play_sound` command on the DataChannel.
     *
     * Returns `false` if the DataChannel isn't open, `true` once
     * the command has been queued. The daemon plays the file
     * asynchronously - the SDK doesn't expose a completion event.
     */
    playSound(file: string): boolean;

    /**
     * Read the daemon's reported version string (e.g. `"1.5.1"`),
     * one-shot over the WebRTC data channel. Resolves to `null`
     * when the channel isn't open yet, or when the daemon predates
     * the `get_version` Cmd.
     */
    getVersion(): Promise<string | null>;

    // ─── Audio volume controls (DataChannel round-trips) ──────────────
    //
    // Mirror of the daemon's `/api/volume/*` REST surface, routed
    // through the WebRTC DataChannel so the mobile app (which can't
    // talk to the daemon directly) can still adjust speaker / mic
    // volume from anywhere on the network. Both methods round-trip
    // and resolve with the daemon's *applied* value (clamped to 0-100,
    // or `null` if the platform doesn't expose volume control).

    /** Speaker volume currently applied on the robot (0-100), or
     *  `null` when the platform's audio stack doesn't expose it. */
    getVolume(): Promise<number | null>;
    /** Set the speaker volume (0-100). Persists across sessions on
     *  the robot side. Resolves with the applied value. */
    setVolume(volume: number): Promise<number | null>;
    /** Microphone input volume currently applied (0-100), or `null`
     *  if unavailable. */
    getMicrophoneVolume(): Promise<number | null>;
    /** Set the microphone input volume (0-100). Persists across
     *  sessions. Resolves with the applied value. */
    setMicrophoneVolume(volume: number): Promise<number | null>;

    // ─── Daemon log streaming (DataChannel) ───────────────────────────
    //
    // Subscribe to the `journalctl -u reachy-mini-daemon` stream over
    // the WebRTC data channel. One daemon-side subprocess is shared
    // across all local subscribers: the first call sends
    // `subscribe_logs`, removing the last subscriber sends
    // `unsubscribe_logs`. Calling the returned `unsubscribe()` more
    // than once is a no-op.

    /**
     * One log line as forwarded by the daemon. `timestamp` is an ISO
     * string from `journalctl --output short-iso`; `line` is the raw
     * formatted log line (Python logger's `levelname` is embedded in
     * the text, so consumers parse it client-side).
     */
    subscribeLogs(options: {
      onLine: (entry: { timestamp: string; line: string }) => void;
      onError?: (error: string) => void;
    }): () => void;
  }

  export default ReachyMini;
}
