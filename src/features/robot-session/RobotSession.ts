/**
 * Robot session: the layer between the Reachy SDK and the
 * conversation engine.
 *
 * Owns
 * ────
 *   - The SDK robot ref (`ReachyMiniInstance`).
 *   - The selected peer id + the list of robots known to the SDK.
 *   - The "session has been established" boolean and the motor-mode
 *     dedup cache.
 *   - The stop-intent counter (via composed `SessionGuard`).
 *   - The video stream cache (via composed `VideoStreamCache`).
 *   - The WebRTC transport monitor (via composed `TransportMonitor`).
 *     Started/stopped automatically by the lifecycle methods so the
 *     monitor follows the session pc instead of the conversation
 *     pipeline. See `setTransportListener()` for the host hook.
 *
 * Exposes
 * ───────
 * High-level lifecycle methods that wrap the SDK + the helpers from
 * sibling modules with the right preconditions and bookkeeping:
 *
 *   - `attachRobot` / `detachRobot`  — bind/unbind the SDK instance.
 *   - `setTransportListener`         — observe live transport kind +
 *                                       bitrate. Started/stopped at
 *                                       the session-pc lifecycle
 *                                       boundaries below.
 *   - `start`                        — run `startRobotSession()`
 *                                       with retry + expectedStop wrap.
 *   - `wakeUp` / `sleepAndDisable`   — physical robot operations,
 *                                       hard-bounded by JS timeouts.
 *   - `stop`                         — `expectedStop(stopSession())`.
 *   - `disconnect`                   — drop the SDK's producer
 *                                       subscription on central.
 *   - `ensureConnected`              — reconnect the SDK if dropped.
 *   - `release`                      — iframe handoff: stop session
 *                                       + disconnect, robot stays awake.
 *   - `reacquire`                    — bring the session back after a
 *                                       release (connect if needed,
 *                                       then start with retry).
 *   - `attachVideo`                  — bind a `<video>` element with
 *                                       cache-replay catch-up.
 *
 * Doesn't own
 * ───────────
 *   - The FSM (`AppState`, `setState`). The conversation engine is
 *     the orchestrator: it calls session methods, then transitions
 *     its FSM. This keeps `RobotSession` free of the
 *     conversation-state vocabulary (`listening`, `ai-speaking`, …).
 *   - Any conversation pipeline (realtime bridge, motion, audio,
 *     tools). Those are pure conversation concerns.
 *   - Host-facing callbacks (`onStateChange`, `onLevels`, …). The
 *     engine forwards them.
 *
 * No constructor deps: the class can be instantiated with `new
 * RobotSession()`. Operation-time hooks (e.g. `onAttempt` for the
 * retry loop) are method-level options. SDK event listeners are
 * wired by the engine's `wireRobot()` rather than here, so the
 * class stays oblivious to FSM-coupled side effects.
 */
import type { ReachyMiniInstance, RobotInfo } from './sdk-types';
import { createSessionGuard, type SessionGuard } from './session-guard';
import { createVideoStreamCache, type VideoStreamCache } from './video-cache';
import { startRobotSession, type StartRobotSessionResult } from './start-session';
import { wakeRobot, sleepAndDisableRobot } from './physical';
import { TransportMonitor, type TransportInfo } from './transport-monitor';
import type { ConversationConnectionAttempt } from '@/features/conversation/engine/types';

export type MotorMode = 'enabled' | 'disabled' | 'gravity_compensation';

export interface SessionStartOptions {
  /** Forwarded to the retry loop's progress callback so the host can
   *  show "Reconnecting… (2 of 2)" during the inter-attempt gap. */
  onAttempt?: (info: ConversationConnectionAttempt | null) => void;
  /** Bail mid-loop if this returns `true`. The host wires it to its
   *  own unmount / leaving signal. */
  isCancelled?: () => boolean;
}

export class RobotSession {
  /**
   * Stop-intent counter. Exposed read-only as `session.guard` so
   * helpers (start-session, …) can take a `SessionGuard` directly.
   */
  readonly guard: SessionGuard = createSessionGuard();

  /**
   * Video stream cache for late-attaching consumers. Exposed as
   * `session.videoCache` so the engine's `videoTrack` listener can
   * `.set(stream)` and the engine's tear-down can `.clear()`.
   */
  readonly videoCache: VideoStreamCache = createVideoStreamCache();

  /**
   * WebRTC transport monitor. Lifecycle-coupled to the session pc:
   *   - started inside `start()` / `reacquire()` once the SDK pc is
   *     up (post-`startRobotSession` ok),
   *   - stopped inside `stop()` / `release()` / `detachRobot()` BEFORE
   *     the pc gets closed, so the next `getStats()` tick doesn't fire
   *     against a dead handle.
   *
   * The host wires a listener once via `setTransportListener()`; the
   * class owns all the start/stop bookkeeping internally so the
   * conversation engine doesn't have to know about session-pc
   * lifecycle events.
   */
  private readonly transportMonitor: TransportMonitor = new TransportMonitor();
  private transportListener: ((info: TransportInfo) => void) | null = null;

  private robot: ReachyMiniInstance | null = null;
  private selectedRobotId: string | null = null;
  private knownRobots: RobotInfo[] = [];
  private established = false;
  private lastMotorMode: MotorMode | null = null;

  // ─── SDK ref management ─────────────────────────────────────────

  attachRobot(robot: ReachyMiniInstance): void {
    this.robot = robot;
  }

  detachRobot(): void {
    // Tear down the monitor BEFORE we drop the SDK ref. The SDK's
    // `disconnect()` (called by the engine right before detachRobot)
    // closes `_pc` and nulls it - if the monitor's next tick lands
    // after that we'd hit a `getStats()` on a dead handle.
    this.stopTransportMonitor();
    this.robot = null;
    this.knownRobots = [];
    this.selectedRobotId = null;
    this.established = false;
    this.lastMotorMode = null;
    this.videoCache.clear();
  }

  // ─── Transport monitor wiring ───────────────────────────────────

  /**
   * Register (or clear, by passing `null`) the listener that receives
   * live transport classification + bitrate updates. The listener is
   * captured here and replayed to the underlying `TransportMonitor`
   * every time the session pc lifecycle re-arms the monitor
   * (`start()` / `reacquire()`).
   *
   * Wired once by the engine at boot - we deliberately don't try to
   * multiplex multiple listeners: there's a single consumer (the
   * React hook). If we ever need fan-out we'll bolt a tiny emitter
   * on top of this setter, but YAGNI for now.
   */
  setTransportListener(listener: ((info: TransportInfo) => void) | null): void {
    this.transportListener = listener;
  }

  private startTransportMonitor(): void {
    const pc = this.robot?._pc;
    if (!pc) return;
    this.transportMonitor.start(pc, this.transportListener);
  }

  private stopTransportMonitor(): void {
    this.transportMonitor.stop();
  }

  getRobot(): ReachyMiniInstance | null {
    return this.robot;
  }

  // ─── Selection state ────────────────────────────────────────────

  getSelectedRobotId(): string | null {
    return this.selectedRobotId;
  }

  setSelectedRobotId(id: string | null): void {
    this.selectedRobotId = id;
  }

  getKnownRobots(): readonly RobotInfo[] {
    return this.knownRobots;
  }

  setKnownRobots(robots: RobotInfo[]): void {
    this.knownRobots = robots;
  }

  /**
   * Auto-pick the first available robot if none is selected. Returns
   * the picked id, or `null` if a pick wasn't possible (no known
   * robots, or one was already selected). The caller is responsible
   * for any FSM transition that follows.
   */
  pickFirstIfNone(): string | null {
    if (this.selectedRobotId) return null;
    const first = this.knownRobots[0];
    if (!first) return null;
    this.selectedRobotId = first.id;
    return first.id;
  }

  // ─── Established flag + motor mode dedup ────────────────────────

  isEstablished(): boolean {
    return this.established;
  }

  setEstablished(value: boolean): void {
    this.established = value;
  }

  getLastMotorMode(): MotorMode | null {
    return this.lastMotorMode;
  }

  recordMotorMode(mode: MotorMode | null): void {
    this.lastMotorMode = mode;
  }

  // ─── Lifecycle operations ───────────────────────────────────────

  /**
   * Reconnect the SDK if it has fallen back to `disconnected`. No-op
   * if already connected. Returns `true` on success (or no-op),
   * `false` if the connect threw.
   */
  async ensureConnected(): Promise<{ ok: true } | { ok: false; reason: Error }> {
    if (!this.robot) {
      return { ok: false, reason: new Error('Robot not attached') };
    }
    if (this.robot.state !== 'disconnected') return { ok: true };
    try {
      await this.robot.connect();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  /**
   * Bring up the WebRTC session against `selectedRobotId`. Wraps
   * `startRobotSession()` (which handles the libnice retry loop +
   * per-attempt timeout). Caller is responsible for any FSM
   * transition (`starting` / `ready` / error reset).
   *
   * On success, arms the transport monitor against the freshly-up
   * `_pc` so the host's listener starts receiving updates as soon as
   * ICE settles. On failure the monitor stays idle.
   */
  async start(opts: SessionStartOptions = {}): Promise<StartRobotSessionResult> {
    if (!this.robot || !this.selectedRobotId) {
      return {
        ok: false,
        reason: new Error('Robot or peer id missing'),
      };
    }
    const result = await startRobotSession({
      robot: this.robot,
      peerId: this.selectedRobotId,
      expectedStop: this.guard.expectedStop,
      onAttempt: opts.onAttempt,
      isCancelled: opts.isCancelled,
    });
    if (result.ok) this.startTransportMonitor();
    return result;
  }

  /**
   * Wake the robot (motors + head/antennas trajectory). Hard-bounded
   * by the helper's JS timeout. Never throws.
   */
  async wakeUp(): Promise<void> {
    if (!this.robot) return;
    await wakeRobot(this.robot);
  }

  /**
   * Play the goto-sleep trajectory then force motor mode to
   * `'disabled'`. Records the result in the dedup cache so the next
   * `syncMotorModeForState` skips redundant writes.
   */
  async sleepAndDisable(): Promise<void> {
    if (!this.robot) return;
    const result = await sleepAndDisableRobot(this.robot);
    this.recordMotorMode(result.motorMode);
  }

  /**
   * `expectedStop`-wrapped `robot.stopSession()`. Marks the stop as
   * intentional so the engine's `sessionStopped` listener doesn't
   * run its unsolicited-drop recovery path on top.
   *
   * Stops the transport monitor first: `stopSession()` doesn't itself
   * close `_pc` (only `disconnect()` does), but the candidate pair
   * goes away with the session so polling `getStats()` after this
   * would only emit `checking` forever - cleaner to just freeze it.
   */
  async stop(): Promise<void> {
    if (!this.robot) return;
    this.stopTransportMonitor();
    await this.guard.expectedStop(() => this.robot!.stopSession());
  }

  /**
   * Drop the SDK's producer subscription on central. Used by
   * `release()` so the iframe's `connect()` becomes the sole
   * subscription for the lease window.
   */
  disconnect(): void {
    this.robot?.disconnect();
  }

  /**
   * Release the WebRTC session for an iframe handoff. Robot stays
   * physically awake. Does NOT touch FSM - the engine sets
   * `'released'` after the conversation cleanup it does on its side.
   *
   * Sequence:
   *   1. Stop the transport monitor (the pc is about to die).
   *   2. Mark established=false so re-entries see "no live session".
   *   3. Reset motor mode cache (the iframe consumer may flip it).
   *   4. Stop the session via expectedStop wrap.
   *   5. Disconnect to free central's producer subscription.
   *
   * No-op if there is no established session.
   */
  async release(): Promise<void> {
    if (!this.robot || !this.established) return;
    this.stopTransportMonitor();
    this.established = false;
    this.lastMotorMode = null;
    const t0 = performance.now();
    await this.guard.expectedStop(() => this.robot!.stopSession());
    console.log(
      `[robot-session] release: stopSession resolved in ${Math.round(
        performance.now() - t0,
      )}ms, robot.state = ${this.robot.state}`,
    );
    this.robot.disconnect();
    console.log(
      `[robot-session] release: disconnected, robot.state = ${this.robot.state}`,
    );
  }

  /**
   * Bring the session back after a `release()`. Reconnects the SDK
   * if dropped, then runs `start()` with the same retry/timeout
   * logic as the initial bring-up (so reacquire benefits from
   * libnice crash recovery for free).
   *
   * Idempotent: returns `{ ok: true }` if already established.
   * Caller is responsible for FSM transitions (`starting` / `ready`).
   *
   * Does NOT call `wakeUp()`: the robot stayed awake during the
   * handoff, so replaying the wake trajectory would defeat the
   * "stay where you were" promise.
   */
  async reacquire(opts: SessionStartOptions = {}): Promise<StartRobotSessionResult> {
    if (!this.robot || !this.selectedRobotId) {
      return {
        ok: false,
        reason: new Error('Robot or peer id missing'),
      };
    }
    if (this.established) return { ok: true };

    const reconnect = await this.ensureConnected();
    if (!reconnect.ok) return reconnect;

    return this.start(opts);
  }

  /**
   * Bind a freshly-mounted `<video>` element to the SDK's video
   * track and replay any cached stream so the element catches up
   * even when mounted AFTER the SDK's one-shot `videoTrack` event.
   * Returns the SDK's detach callback.
   */
  attachVideo(videoElement: HTMLVideoElement): () => void {
    if (!this.robot) return () => {};
    try {
      const detach = this.robot.attachVideo(videoElement);
      this.videoCache.replayInto(videoElement);
      return detach;
    } catch (err) {
      console.warn('[robot-session] attachVideo failed:', err);
      return () => {};
    }
  }
}
