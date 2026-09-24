/**
 * Telepresence motion controller.
 *
 * Pure (React-free) integrator that turns the operator's inputs into
 * `set_full_target` frames on a fixed 20 Hz tick:
 *
 *   - the head joystick (velocity input, `[-1, 1]^2`) drives the head
 *     pitch + head yaw RELATIVE to the base;
 *   - the settings sliders (position input) drive head roll, base yaw
 *     and both antennas. Slider targets are slew-limited so a fast drag
 *     never slams a motor straight to its new setpoint.
 *
 * Yaw model - "leash"
 * ───────────────────
 * The base yaw is an explicit, user-visible quantity (the "Base" slider),
 * so the state is `(bodyYaw, headYawRel)` rather than a single world yaw:
 *
 *   headYawWorld = bodyYaw + headYawRel,   |headYawRel| ≤ HEAD_YAW_REL_LIMIT
 *
 * The joystick moves the head freely inside its ±60° leash around the
 * base. Pushing further while the head is pinned at the leash drags the
 * base along (at the slower body speed) and the base slider follows. The
 * base stays where it was left when the stick is released - it only moves
 * back when the operator drags the slider or hits "reset pose". Head and
 * body always travel in the SAME frame so the daemon never sees a
 * transient head-vs-body yaw gap past its 65° check.
 *
 * Sign convention (screen joystick, +y = down): push right → look right →
 * yaw DECREASES; push up → look up → pitch DECREASES. Same as the
 * telepresence Space and the old head-control widget.
 *
 * Ownership. Until the operator touches a control ("engaged"), the model
 * FOLLOWS the robot's reported pose (`getRobotPose`) and sends nothing, so
 * the first touch continues from wherever the robot actually is instead of
 * snapping to zero. Whenever motion isn't allowed (`canMove()` false:
 * asleep, waking, wizard up, session tearing down) the controller drops
 * ownership and goes back to following. Frames are deduplicated so an idle
 * stick costs zero data-channel traffic.
 */

/** Subset of the SDK instance the controller drives (see `setTarget`). */
export interface MotionSink {
  setTarget(target: { head?: number[]; antennas?: number[]; body_yaw?: number }): boolean;
}

/** Robot-reported pose, degrees. Any field may be unknown. */
export interface ReportedPose {
  roll?: number;
  pitch?: number;
  /** Head yaw in the WORLD frame. */
  yaw?: number;
  bodyYaw?: number;
  antennaRight?: number;
  antennaLeft?: number;
}

export interface TelepresencePose {
  /** Head yaw relative to the base, deg. */
  headYawRel: number;
  pitch: number;
  roll: number;
  bodyYaw: number;
  antennaRight: number;
  antennaLeft: number;
}

/** Slider-driven setpoints. The live pose slews toward them. */
export interface TelepresenceTargets {
  roll: number;
  bodyYaw: number;
  antennaRight: number;
  antennaLeft: number;
}

/** What the UI renders. Deliberately excludes the 20 Hz live pose. */
export interface MotionSnapshot {
  targets: TelepresenceTargets;
  /** Head drifted off its neutral (rel yaw / pitch) - drives the recenter button. */
  headOffCenter: boolean;
}

export const TELEPRESENCE_LIMITS = {
  /** Daemon IK enforces |head_yaw_world - body| ≤ 65°; 5° margin. */
  headYawRelDeg: 60,
  pitchDeg: 40,
  rollDeg: 30,
  /** HEAD_YAW_REL + BODY_YAW < 180° keeps the daemon's atan2 from wrapping. */
  bodyYawDeg: 115,
  antennaDeg: 90,
} as const;

export const TELEPRESENCE_SPEEDS = {
  /** Velocity caps at full stick deflection (post quadratic curve). */
  headYawDegPerSec: 60,
  pitchDegPerSec: 40,
  /** Base drag speed once the head is pinned at its leash. */
  bodySpillDegPerSec: 50,
  /** Slew limits applied to slider targets. */
  bodySlewDegPerSec: 90,
  rollSlewDegPerSec: 60,
  antennaSlewDegPerSec: 180,
  /** Recenter / park glide. */
  recenterDegPerSec: 90,
} as const;

export const CONTROL_TICK_MS = 50;
const HEAD_DELTA_DEG = 0.3;
const ANTENNA_DELTA_DEG = 0.5;
const OFF_CENTER_DEG = 1;
const GRAB_THRESHOLD = 0.01;

const DEG = Math.PI / 180;

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

function quadratic(value: number): number {
  return value * Math.abs(value);
}

/** Move `current` toward `target` by at most `maxStep`. */
function slew(current: number, target: number, maxStep: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

/** ZYX roll/pitch/yaw (deg) → flat row-major 4x4, same as the SDK's `rpyToMatrix`. */
export function rpyToFlatMatrix(rollDeg: number, pitchDeg: number, yawDeg: number): number[] {
  const r = rollDeg * DEG;
  const p = pitchDeg * DEG;
  const y = yawDeg * DEG;
  const cy = Math.cos(y), sy = Math.sin(y);
  const cp = Math.cos(p), sp = Math.sin(p);
  const cr = Math.cos(r), sr = Math.sin(r);
  return [
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, 0,
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, 0,
    -sp, cp * sr, cp * cr, 0,
    0, 0, 0, 1,
  ];
}

/** Inverse of `rpyToFlatMatrix` (rotation part only), degrees. */
export function flatMatrixToRpy(m: readonly number[]): { roll: number; pitch: number; yaw: number } {
  return {
    roll: Math.atan2(m[9], m[10]) / DEG,
    pitch: Math.asin(Math.max(-1, Math.min(1, -m[8]))) / DEG,
    yaw: Math.atan2(m[4], m[0]) / DEG,
  };
}

export interface TelepresenceMotionOptions {
  /** Re-read on every tick: the SDK instance changes across re-dials. */
  getSink: () => MotionSink | null;
  /** Live stick deflection (`[-1, 1]^2`, +y down), or null when not mounted. */
  getDeflection: () => { x: number; y: number } | null;
  /** Latest robot-reported pose, followed while the operator isn't in control. */
  getRobotPose?: () => ReportedPose | null;
  /** Hard gate: false = send nothing and hand ownership back to the robot. */
  canMove?: () => boolean;
}

export class TelepresenceMotionController {
  private pose: TelepresencePose = {
    headYawRel: 0,
    pitch: 0,
    roll: 0,
    bodyYaw: 0,
    antennaRight: 0,
    antennaLeft: 0,
  };
  private targets: TelepresenceTargets = { roll: 0, bodyYaw: 0, antennaRight: 0, antennaLeft: 0 };
  /** Last frame actually sent; NaN = never sent. */
  private sent = { roll: NaN, pitch: NaN, yaw: NaN, body: NaN, antR: NaN, antL: NaN };
  /** Operator owns the pose (touched a control since the last hand-back). */
  private engaged = false;
  private recentering = false;
  /** Identity of the in-flight park(); cleared by start()/stop(). */
  private parkToken: object | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: MotionSnapshot;

  constructor(private readonly opts: TelepresenceMotionOptions) {
    this.snapshot = this.buildSnapshot();
  }

  start(): void {
    // An explicit (re)start supersedes any in-flight park: its trailing
    // stop() must not kill the loop we're starting now.
    this.parkToken = null;
    this.startTimer();
  }

  stop(): void {
    this.parkToken = null;
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  // ─── Operator inputs ─────────────────────────────────────────────

  setRollTarget(deg: number): void {
    this.setTargets({ roll: clamp(deg, TELEPRESENCE_LIMITS.rollDeg) });
  }

  setBodyYawTarget(deg: number): void {
    this.setTargets({ bodyYaw: clamp(deg, TELEPRESENCE_LIMITS.bodyYawDeg) });
  }

  setAntennasTarget(right: number, left: number): void {
    this.setTargets({
      antennaRight: clamp(right, TELEPRESENCE_LIMITS.antennaDeg),
      antennaLeft: clamp(left, TELEPRESENCE_LIMITS.antennaDeg),
    });
  }

  /** Glide head pitch + relative yaw back to neutral (base untouched). */
  recenterHead(): void {
    if (!this.allowed()) return;
    this.engaged = true;
    this.recentering = true;
  }

  /** Every slider back to 0 + head recenter. */
  resetPose(): void {
    if (!this.allowed()) return;
    this.targets = { roll: 0, bodyYaw: 0, antennaRight: 0, antennaLeft: 0 };
    this.recenterHead();
    this.emit();
  }

  /**
   * Glide everything back to neutral (ignoring the joystick, which may be
   * frozen mid-drag by an unmount), then stop ticking and hand ownership
   * back to the robot. Resolves once neutral, on `timeoutMs`, or when a
   * start()/stop() supersedes it. Immediate when nothing was moved.
   */
  async park(timeoutMs = 2500): Promise<void> {
    if (!this.engaged || !this.allowed()) {
      this.stop();
      this.engaged = false;
      return;
    }
    this.resetPose();
    const token = {};
    this.startTimer();
    this.parkToken = token;
    const deadline = Date.now() + timeoutMs;
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.parkToken !== token || this.isNeutral() || Date.now() > deadline) {
          clearInterval(check);
          resolve();
        }
      }, CONTROL_TICK_MS);
    });
    if (this.parkToken === token) {
      this.stop();
      this.engaged = false;
    }
  }

  // ─── Observable state (useSyncExternalStore-compatible) ──────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): MotionSnapshot => this.snapshot;

  /** Live integrated pose (changes every tick; not observable on purpose). */
  getPose(): TelepresencePose {
    return this.pose;
  }

  // ─── Integration ─────────────────────────────────────────────────

  /** One control step. Public for tests; normally driven by `start()`. */
  tick(dtSec: number): void {
    if (!this.allowed()) {
      // Robot not ours to move: forget any operator ownership and track
      // whatever it reports, so the next touch starts from reality.
      this.engaged = false;
      this.recentering = false;
      this.follow();
      this.emit();
      return;
    }

    const parking = this.parkToken !== null;
    const def = parking ? { x: 0, y: 0 } : (this.opts.getDeflection() ?? { x: 0, y: 0 });
    const grabbing = Math.hypot(def.x, def.y) > GRAB_THRESHOLD;
    if (grabbing) {
      this.engaged = true;
      this.recentering = false;
    }
    if (!this.engaged) {
      this.follow();
      this.emit();
      return;
    }

    const p = { ...this.pose };
    const L = TELEPRESENCE_LIMITS;
    const S = TELEPRESENCE_SPEEDS;

    if (this.recentering) {
      const step = S.recenterDegPerSec * dtSec;
      p.headYawRel = slew(p.headYawRel, 0, step);
      p.pitch = slew(p.pitch, 0, step);
      if (p.headYawRel === 0 && p.pitch === 0) this.recentering = false;
    } else if (grabbing) {
      const yawDelta = -quadratic(def.x) * S.headYawDegPerSec * dtSec;
      const nextRel = p.headYawRel + yawDelta;
      if (Math.abs(nextRel) > L.headYawRelDeg) {
        // Pinned at the leash: the head stays put relative to the base
        // and the base swivels along at its own (slower) speed.
        p.headYawRel = Math.sign(nextRel) * L.headYawRelDeg;
        const bodyDelta = -quadratic(def.x) * S.bodySpillDegPerSec * dtSec;
        p.bodyYaw = clamp(p.bodyYaw + bodyDelta, L.bodyYawDeg);
        // Keep the slider target glued to the dragged base so the slew
        // below doesn't pull it back.
        this.targets = { ...this.targets, bodyYaw: p.bodyYaw };
      } else {
        p.headYawRel = nextRel;
      }
      p.pitch = clamp(p.pitch + quadratic(def.y) * S.pitchDegPerSec * dtSec, L.pitchDeg);
    }

    p.bodyYaw = slew(p.bodyYaw, this.targets.bodyYaw, S.bodySlewDegPerSec * dtSec);
    p.roll = slew(p.roll, this.targets.roll, S.rollSlewDegPerSec * dtSec);
    p.antennaRight = slew(p.antennaRight, this.targets.antennaRight, S.antennaSlewDegPerSec * dtSec);
    p.antennaLeft = slew(p.antennaLeft, this.targets.antennaLeft, S.antennaSlewDegPerSec * dtSec);

    this.pose = p;
    this.flush();
    this.emit();
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(CONTROL_TICK_MS / 1000), CONTROL_TICK_MS);
  }

  private allowed(): boolean {
    return this.opts.canMove?.() ?? true;
  }

  private setTargets(patch: Partial<TelepresenceTargets>): void {
    if (!this.allowed()) return;
    this.engaged = true;
    this.targets = { ...this.targets, ...patch };
    this.emit();
  }

  /** Mirror the robot-reported pose into the model (not engaged). */
  private follow(): void {
    const r = this.opts.getRobotPose?.();
    if (!r) return;
    const p = { ...this.pose };
    if (r.bodyYaw !== undefined) p.bodyYaw = r.bodyYaw;
    if (r.yaw !== undefined) p.headYawRel = r.yaw - p.bodyYaw;
    if (r.pitch !== undefined) p.pitch = r.pitch;
    if (r.roll !== undefined) p.roll = r.roll;
    if (r.antennaRight !== undefined) p.antennaRight = r.antennaRight;
    if (r.antennaLeft !== undefined) p.antennaLeft = r.antennaLeft;
    this.pose = p;
    this.targets = {
      roll: clamp(p.roll, TELEPRESENCE_LIMITS.rollDeg),
      bodyYaw: clamp(p.bodyYaw, TELEPRESENCE_LIMITS.bodyYawDeg),
      antennaRight: clamp(p.antennaRight, TELEPRESENCE_LIMITS.antennaDeg),
      antennaLeft: clamp(p.antennaLeft, TELEPRESENCE_LIMITS.antennaDeg),
    };
    // The next engaged frame must go out whatever was sent before.
    this.sent = { roll: NaN, pitch: NaN, yaw: NaN, body: NaN, antR: NaN, antL: NaN };
  }

  private flush(): void {
    const sink = this.opts.getSink();
    if (!sink) return;
    const p = this.pose;
    const s = this.sent;
    const yawWorld = p.bodyYaw + p.headYawRel;

    const headOrBodyChanged =
      changed(s.roll, p.roll, HEAD_DELTA_DEG) ||
      changed(s.pitch, p.pitch, HEAD_DELTA_DEG) ||
      changed(s.yaw, yawWorld, HEAD_DELTA_DEG) ||
      changed(s.body, p.bodyYaw, HEAD_DELTA_DEG);
    const antennasChanged =
      changed(s.antR, p.antennaRight, ANTENNA_DELTA_DEG) ||
      changed(s.antL, p.antennaLeft, ANTENNA_DELTA_DEG);
    if (!headOrBodyChanged && !antennasChanged) return;

    const frame: { head?: number[]; antennas?: number[]; body_yaw?: number } = {};
    if (headOrBodyChanged) {
      frame.head = rpyToFlatMatrix(p.roll, p.pitch, yawWorld);
      frame.body_yaw = p.bodyYaw * DEG;
    }
    if (antennasChanged) frame.antennas = [p.antennaRight * DEG, p.antennaLeft * DEG];
    if (!sink.setTarget(frame)) return;
    if (headOrBodyChanged) {
      this.sent = { ...this.sent, roll: p.roll, pitch: p.pitch, yaw: yawWorld, body: p.bodyYaw };
    }
    if (antennasChanged) {
      this.sent = { ...this.sent, antR: p.antennaRight, antL: p.antennaLeft };
    }
  }

  private isNeutral(): boolean {
    return Object.values(this.pose).every((v) => Math.abs(v) < HEAD_DELTA_DEG);
  }

  private buildSnapshot(): MotionSnapshot {
    return {
      targets: this.targets,
      headOffCenter:
        Math.abs(this.pose.headYawRel) > OFF_CENTER_DEG ||
        Math.abs(this.pose.pitch) > OFF_CENTER_DEG,
    };
  }

  /** Notify React only on a visible change - never on the 20 Hz pose alone. */
  private emit(): void {
    const next = this.buildSnapshot();
    const prev = this.snapshot;
    if (
      prev.headOffCenter === next.headOffCenter &&
      sameTargets(prev.targets, next.targets)
    ) {
      return;
    }
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}

/** `NaN` (never sent) always counts as changed. */
function changed(sent: number, next: number, threshold: number): boolean {
  return Number.isNaN(sent) || Math.abs(next - sent) >= threshold;
}

function sameTargets(a: TelepresenceTargets, b: TelepresenceTargets): boolean {
  return (
    a.roll === b.roll &&
    a.bodyYaw === b.bodyYaw &&
    a.antennaRight === b.antennaRight &&
    a.antennaLeft === b.antennaLeft
  );
}
