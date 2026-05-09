/**
 * Robot session state holder.
 *
 * Composes the smaller session-layer modules (`SessionGuard`,
 * `VideoStreamCache`) and owns the session-level state vars that
 * used to live in the conversation engine's closure:
 *
 *   - `sessionEstablished`     → has the WebRTC + DataChannel handshake
 *                                resolved? Used by the conversation
 *                                engine to gate motor mode side effects
 *                                and the `releaseSessionKeepAwake` /
 *                                `reacquireSession` precondition checks.
 *   - `lastSetMotorMode`       → dedup cache for `robot.setMotorMode()`.
 *                                Without it, the engine emits one
 *                                redundant motor-mode message per
 *                                conversation turn boundary.
 *
 * Ownership boundary
 * ──────────────────
 * THIS class owns the SESSION state. The conversation engine still
 * owns:
 *   - the FSM (`AppState`, `setState`)
 *   - the conversation pipeline (OpenAI bridge, motion controllers,
 *     audio monitors, tool-call handler)
 *   - the host-facing callbacks (onStateChange, onLevels, etc.)
 *
 * The engine creates ONE `RobotSession` instance per `mountConversation`
 * call and uses it as a small state object. Subsequent extraction
 * commits can move more state and methods (the SDK robot ref, the
 * selected peer id, the listeners, the release/reacquire lifecycle)
 * here without re-shaping the engine's external API.
 */
import { createSessionGuard, type SessionGuard } from './session-guard';
import { createVideoStreamCache, type VideoStreamCache } from './video-cache';

/**
 * Motor mode values accepted by the daemon. `enabled` and `disabled`
 * are the two we drive in practice; `gravity_compensation` is left
 * in the type for forward-compat (the daemon's Placo backend supports
 * it but the default kinematics engine doesn't).
 */
export type MotorMode = 'enabled' | 'disabled' | 'gravity_compensation';

export class RobotSession {
  /**
   * Embedded session-stop intent counter. Exposed read-only as
   * `session.guard` so the engine can pass it to helpers
   * (`startRobotSession`, etc.) without going through the class.
   */
  readonly guard: SessionGuard = createSessionGuard();

  /**
   * Embedded video stream cache. Same exposure pattern as `guard`:
   * the engine accesses it via `session.videoCache.set()` /
   * `session.videoCache.replayInto()` etc.
   */
  readonly videoCache: VideoStreamCache = createVideoStreamCache();

  private _established = false;
  private _lastMotorMode: MotorMode | null = null;

  /**
   * Whether `robot.startSession()` has resolved successfully. The
   * engine flips this to `true` after a successful session-start +
   * wake-up, and back to `false` during teardown / release.
   */
  isEstablished(): boolean {
    return this._established;
  }

  setEstablished(value: boolean): void {
    this._established = value;
  }

  /**
   * Last motor mode actually written to the SDK. Read by
   * `syncMotorModeForState()` in the engine to dedup redundant
   * `robot.setMotorMode()` calls across conversation turn
   * boundaries.
   *
   * `null` means "no known mode yet" - typically right after a
   * release+reacquire where the iframe consumer may have flipped
   * the mode and we no longer have an authoritative view.
   */
  getLastMotorMode(): MotorMode | null {
    return this._lastMotorMode;
  }

  /**
   * Record the motor mode just sent (or `null` to invalidate the
   * cache and force the next state transition to send through).
   */
  recordMotorMode(mode: MotorMode | null): void {
    this._lastMotorMode = mode;
  }
}
