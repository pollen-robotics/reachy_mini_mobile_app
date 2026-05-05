/**
 * Minimal TypeScript surface for the JS SDK shipped at ./reachy-mini.js.
 *
 * The SDK itself is plain JavaScript (vendored from the daemon repo at
 * `reachy_mini/js/reachy-mini.js`); this file only declares the subset
 * we actually call from the mobile app. Keep in sync with the daemon
 * SDK when adding fields - the runtime is the source of truth.
 */

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
  }): void;
  setHeadOrientation(rollDeg: number, pitchDeg: number, yawDeg: number): void;
  setAntennasDeg(rightDeg: number, leftDeg: number): void;
  setBodyYawDeg(yawDeg: number): void;

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
}

export default ReachyMini;
