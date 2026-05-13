/**
 * Head + body velocity controller (tank-style).
 *
 * Translates a normalised joystick deflection (`[-1, 1]^2`) into a
 * stream of `setHeadRpyDeg` + `setBodyYawDeg` commands at a bounded
 * rate. Two integrated state variables drive the robot:
 *
 *   - `headYawRel`  : head yaw RELATIVE to the base, ∈ [-LIMIT, +LIMIT]
 *   - `bodyYaw`     : base orientation, ∈ [-BODY_LIMIT, +BODY_LIMIT]
 *
 * Critical: the daemon's `setHeadRpyDeg` consumes a head pose in
 * WORLD frame (the IK splits the requested world yaw between body
 * rotation and the Stewart platform). The relative head/body yaw
 * is mechanically capped by the IK at ~65° (`|head_world - body| ≤ 65°`).
 * So once the base starts rotating, the WORLD yaw we command the
 * head MUST follow the base, otherwise the relative yaw drifts and
 * the IK clamps body_yaw aggressively. See the cdussieux reference
 * demo (`huggingface.co/spaces/cduss/webrtc_example`) for the canonical
 * pattern this hook implements.
 *
 * `atan2` wrap caveat
 * ───────────────────
 * `head_yaw_world` is shipped as one of the RPY components of a
 * rotation matrix. The daemon recovers it with `atan2`, which
 * returns angles in `[-π, +π]`. If we ever command an absolute
 * world yaw above 180°, the daemon decodes a value wrapped by ±360°
 * and its safe-IK uses the wrapped value for the `|head - body|`
 * comparison - producing a spurious "out of envelope" rewrite of
 * `body_yaw` to the opposite side of the range. The user perceives
 * this as the base flipping right before it hits the requested
 * extreme. To avoid it we cap `HEAD_YAW_LIMIT_DEG + BODY_YAW_LIMIT_DEG`
 * under 180° in `constants.ts`; the world yaw we send is guaranteed
 * to stay strictly inside the `atan2` codomain.
 *
 * The wire-level command is:
 *
 *     head_yaw_world = headYawRel + bodyYaw
 *
 * Sending head and body separately is fine in practice because the
 * data channel is ordered; we send `setBodyYawDeg` first and then
 * `setHeadRpyDeg` so the daemon sees the new body before re-evaluating
 * the head IK.
 *
 * Architecture
 * ────────────
 *
 *   joystick deflection (ref)  ←  pointer events (read at 20 Hz)
 *           │
 *           ▼
 *   quadratic curve + sign mapping + scale by MAX *_DEG_PER_SEC
 *           │
 *           ▼
 *   integrate headYawRel/pitch  →  clamp to head soft limits
 *           │
 *           ▼
 *   if headYawRel is saturated AND joystick still pushes that way:
 *     integrate bodyYaw  →  clamp to body soft limit
 *           │
 *           ▼
 *   send `setBodyYawDeg(bodyYaw)` then
 *        `setHeadRpyDeg(0, pitch, headYawRel + bodyYaw)`
 *
 * Why velocity-based (not position-based)
 * ───────────────────────────────────────
 * Position-based mapping (joystick coordinates ↔ absolute head
 * angle) caps the user at the joystick's max deflection times the
 * head's debattement, which would force them to choose between
 * "regarder finement" (small head range) and "regarder autour"
 * (full range). Velocity-based gives both: small deflection = slow
 * scan, full deflection = fast slew, and the soft clamp on the
 * integrated state stops the head at the physical edge without
 * locking the joystick. Standard FPS / drone idiom.
 *
 * Body-yaw overflow
 * ─────────────────
 * The head only debattes ±60° in yaw relative to the base - not
 * enough to scan a whole room. Rather than expose a second control
 * surface for the base, we treat the joystick as a single "rotate
 * the gaze" command and let the demand spill over once the head has
 * reached its mechanical edge relative to the base:
 *
 *   - small / medium deflection → head moves, base idle
 *   - full deflection + held    → head saturates fast at its limit,
 *                                 base starts rotating in the same
 *                                 direction WHILE the head world yaw
 *                                 keeps tracking the base (so the
 *                                 head stays at its max relative yaw,
 *                                 i.e. the user keeps "looking in the
 *                                 same direction relative to the base")
 *
 * Recenter on unmount
 * ───────────────────
 * When the host unmounts the controller (typically because the
 * user navigated away from the Robot tab), the hook spawns a
 * fire-and-forget rAF loop that interpolates BOTH `headYawRel` and
 * `bodyYaw` back to 0 over `RECENTER_DURATION_MS`. The loop survives
 * the React unmount: it captures the session setters and the initial
 * state into local closures, then runs to completion independently.
 */
import { useEffect, useRef } from 'react';

import {
  BODY_YAW_LIMIT_DEG,
  CONTROL_TICK_MS,
  HEAD_PITCH_MAX_DEG,
  HEAD_PITCH_MIN_DEG,
  HEAD_YAW_LIMIT_DEG,
  HEAD_YAW_SATURATION_MARGIN_DEG,
  MAX_BODY_YAW_DEG_PER_SEC,
  MAX_PITCH_DEG_PER_SEC,
  MAX_YAW_DEG_PER_SEC,
  RECENTER_DURATION_MS,
  RECENTER_FRAMES_PER_SEC,
  TARGET_DELTA_THRESHOLD_DEG,
} from './constants';

export type HeadCommand = (
  rollDeg: number,
  pitchDeg: number,
  yawDeg: number,
) => boolean;

export type BodyYawCommand = (yawDeg: number) => boolean;

export interface UseHeadVelocityControlOptions {
  /**
   * Reference to the joystick's normalised deflection. The
   * controller reads this every `CONTROL_TICK_MS` ms and integrates
   * it into the head state. Mutable so the joystick can keep
   * writing without React re-renders.
   */
  deflectionRef: React.RefObject<{ x: number; y: number }>;
  /**
   * Pass-through to the SDK's `setHeadRpyDeg`. Receives degrees,
   * returns whether the command was queued onto the DataChannel.
   * The hook never throws - failures are swallowed (the joystick
   * keeps working visually, the next successful tick catches up).
   */
  setHeadRpyDeg: HeadCommand;
  /**
   * Pass-through to the SDK's `setBodyYawDeg`. Receives degrees,
   * returns whether the command was queued onto the DataChannel.
   * Same swallow-failures contract as `setHeadRpyDeg`. Called only
   * during head-yaw-saturated ticks and during the recenter on
   * unmount - never on every tick, so DataChannel pressure stays
   * bounded.
   */
  setBodyYawDeg: BodyYawCommand;
  /**
   * When `false`, the controller stops the tick timer and the
   * integrated state is reset to zero. Used by the host to gate
   * the controller on engine readiness (no point integrating
   * commands the SDK will drop) and to suspend it during
   * autonomous head motion (wake_up, dance, …).
   *
   * Flipping `enabled` from `true` to `false` does NOT trigger
   * the recenter - that runs only on unmount. Flipping back to
   * `true` resumes from `(0, 0)`, which is fine in practice
   * because the daemon keeps the head at its last commanded
   * position regardless.
   */
  enabled: boolean;
}

/**
 * Apply a sign-preserving quadratic curve. `f(x) = x * |x|`,
 * mapping `[-1, 1] → [-1, 1]` with `f(0) = 0`, `f(±1) = ±1`, and
 * a softer slope near the origin. Cheap, no `Math.pow`.
 */
function quadratic(value: number): number {
  return value * Math.abs(value);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function useHeadVelocityControl({
  deflectionRef,
  setHeadRpyDeg,
  setBodyYawDeg,
  enabled,
}: UseHeadVelocityControlOptions): void {
  /**
   * Head yaw RELATIVE to the base, ∈ [-HEAD_YAW_LIMIT_DEG, +HEAD_YAW_LIMIT_DEG].
   * The wire-level head yaw we send is the WORLD yaw, computed as
   * `headYawRel + bodyYaw`. Keeping the state in relative coordinates
   * means the saturation gate works on the relative angle (= the
   * angle that's actually mechanically capped by the IK at ~65°), and
   * the recenter loop interpolates the same quantity the user feels.
   */
  const headYawRelRef = useRef(0);
  const pitchRef = useRef(0);
  /**
   * Base orientation, absolute. Kept separately so the saturation
   * gate doesn't have to share state with the head, and so the
   * recenter on unmount can interpolate both axes in parallel.
   */
  const bodyYawRef = useRef(0);
  /**
   * Last commanded WORLD-frame yaw / pitch and body yaw, used by
   * the threshold gate to skip redundant commands when the
   * integration produced a sub-threshold delta. Compared against
   * the WORLD yaw we just computed (`headYawRel + bodyYaw`), not
   * the relative yaw - otherwise a moving base wouldn't trigger
   * an updated head command even though the wire-level world yaw
   * IS changing.
   */
  const lastCommandedHeadYawWorldRef = useRef(Number.POSITIVE_INFINITY);
  const lastCommandedPitchRef = useRef(Number.POSITIVE_INFINITY);
  const lastCommandedBodyYawRef = useRef(Number.POSITIVE_INFINITY);
  /**
   * Pinned reference to the latest setters so the recenter loop on
   * unmount can keep firing commands after the React closure that
   * created it has been disposed.
   */
  const setHeadRpyDegRef = useRef(setHeadRpyDeg);
  const setBodyYawDegRef = useRef(setBodyYawDeg);
  useEffect(() => {
    setHeadRpyDegRef.current = setHeadRpyDeg;
  }, [setHeadRpyDeg]);
  useEffect(() => {
    setBodyYawDegRef.current = setBodyYawDeg;
  }, [setBodyYawDeg]);

  // Active control loop. Runs only while `enabled === true`.
  useEffect(() => {
    if (!enabled) {
      // Hard reset so a re-enable doesn't carry over stale state.
      headYawRelRef.current = 0;
      pitchRef.current = 0;
      bodyYawRef.current = 0;
      lastCommandedHeadYawWorldRef.current = Number.POSITIVE_INFINITY;
      lastCommandedPitchRef.current = Number.POSITIVE_INFINITY;
      lastCommandedBodyYawRef.current = Number.POSITIVE_INFINITY;
      return undefined;
    }

    const dtSec = CONTROL_TICK_MS / 1000;

    const tick = () => {
      const def = deflectionRef.current;
      if (!def) return;

      // Quadratic curve on each axis. The deflection has already
      // been deadzoned in `useJoystickPointer`, so a 0 here means
      // "thumb is at rest" and we should not integrate.
      const curveX = quadratic(def.x);
      const curveY = quadratic(def.y);

      // Sign mapping (cf. constants doc):
      //   push right (x > 0) → look right → yaw decreases
      //   push up    (y < 0) → look up    → on the robot frame this
      //                                     means pitch decreases
      //                                     because `pitch > 0` is
      //                                     chin DOWN on Reachy Mini.
      const headYawRelDelta = -curveX * MAX_YAW_DEG_PER_SEC * dtSec;
      const pitchDelta = curveY * MAX_PITCH_DEG_PER_SEC * dtSec;

      const nextHeadYawRel = clamp(
        headYawRelRef.current + headYawRelDelta,
        -HEAD_YAW_LIMIT_DEG,
        HEAD_YAW_LIMIT_DEG,
      );
      const nextPitch = clamp(
        pitchRef.current + pitchDelta,
        HEAD_PITCH_MIN_DEG,
        HEAD_PITCH_MAX_DEG,
      );

      headYawRelRef.current = nextHeadYawRel;
      pitchRef.current = nextPitch;

      // Body-yaw overflow gate. Two conditions both have to hold:
      //
      //   1. the joystick is still pushing in some direction on X
      //      (curveX !== 0 after the deadzone),
      //   2. the head RELATIVE yaw is at (or within a small margin of)
      //      its hard stop ON THE SIDE THE USER IS PUSHING TOWARD -
      //      we don't want a still-centred-but-zero-velocity head to
      //      spuriously trigger a base rotation just because the
      //      stick happens to be off-centre on Y.
      //
      // The sign matches the head's: pushing the stick right makes
      // both the head yaw target and the body yaw target decrease
      // (right-hand Z-up convention, see constants.ts header).
      let nextBodyYaw = bodyYawRef.current;
      const pushingRight = curveX > 0;
      const pushingLeft = curveX < 0;
      const headSaturatedRight =
        pushingRight &&
        nextHeadYawRel <= -HEAD_YAW_LIMIT_DEG + HEAD_YAW_SATURATION_MARGIN_DEG;
      const headSaturatedLeft =
        pushingLeft &&
        nextHeadYawRel >= HEAD_YAW_LIMIT_DEG - HEAD_YAW_SATURATION_MARGIN_DEG;
      if (headSaturatedLeft || headSaturatedRight) {
        const bodyYawDelta = -curveX * MAX_BODY_YAW_DEG_PER_SEC * dtSec;
        nextBodyYaw = clamp(
          bodyYawRef.current + bodyYawDelta,
          -BODY_YAW_LIMIT_DEG,
          BODY_YAW_LIMIT_DEG,
        );
      }
      bodyYawRef.current = nextBodyYaw;

      // Tank-style: the daemon interprets the head yaw in WORLD
      // frame, so we compose head + body before sending. Keeping
      // headYawRel constant while body rotates yields a fixed
      // head/body relative angle - the head "follows" the base in
      // world frame instead of being left behind (which would cause
      // the IK to clamp body_yaw at ±65° relative). See cdussieux's
      // webrtc_example demo for the canonical pattern.
      const nextHeadYawWorld = nextHeadYawRel + nextBodyYaw;

      // Threshold gate: avoid spamming the DataChannel with
      // identical commands when the joystick is in the deadzone
      // and the integration produced no meaningful change. Head
      // and body are gated separately so a body-only update
      // (head fully saturated and held) doesn't get rate-limited
      // by an unchanged head state - except that in our tank
      // setup head world ALWAYS changes when body changes, so in
      // practice the gates are synchronized once we cross into
      // overflow.
      const headYawWorldDiff = Math.abs(
        nextHeadYawWorld - lastCommandedHeadYawWorldRef.current,
      );
      const pitchDiff = Math.abs(nextPitch - lastCommandedPitchRef.current);
      const bodyYawDiff = Math.abs(
        nextBodyYaw - lastCommandedBodyYawRef.current,
      );

      const bodyChanged = bodyYawDiff >= TARGET_DELTA_THRESHOLD_DEG;
      const headChanged =
        headYawWorldDiff >= TARGET_DELTA_THRESHOLD_DEG ||
        pitchDiff >= TARGET_DELTA_THRESHOLD_DEG;

      // Send body BEFORE head so the daemon sees the new base
      // orientation when it re-evaluates the head IK. The
      // DataChannel is ordered, so successive sends arrive in
      // order on the daemon side; this avoids a transient frame
      // where the IK would clamp head against the previous body.
      if (bodyChanged) {
        lastCommandedBodyYawRef.current = nextBodyYaw;
        setBodyYawDegRef.current(nextBodyYaw);
      }

      if (headChanged) {
        lastCommandedHeadYawWorldRef.current = nextHeadYawWorld;
        lastCommandedPitchRef.current = nextPitch;
        setHeadRpyDegRef.current(0, nextPitch, nextHeadYawWorld);
      }
    };

    const interval = window.setInterval(tick, CONTROL_TICK_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [enabled, deflectionRef]);

  // Recenter on unmount. Spawned outside React's lifecycle so the
  // animation can outlive the component.
  useEffect(() => {
    return () => {
      const startHeadYawRel = headYawRelRef.current;
      const startPitch = pitchRef.current;
      const startBodyYaw = bodyYawRef.current;
      // Skip the recenter when nothing to recenter from. Avoids
      // a useless burst of `setHeadRpyDeg(0, 0, 0)` calls on a
      // mount/unmount with no user interaction.
      if (
        Math.abs(startHeadYawRel) < 0.5 &&
        Math.abs(startPitch) < 0.5 &&
        Math.abs(startBodyYaw) < 0.5
      ) {
        return;
      }

      const headSetter = setHeadRpyDegRef.current;
      const bodySetter = setBodyYawDegRef.current;
      const startTime = performance.now();
      const frameInterval = 1000 / RECENTER_FRAMES_PER_SEC;
      let lastFrameTime = 0;

      const raf = (now: number) => {
        if (now - lastFrameTime < frameInterval) {
          window.requestAnimationFrame(raf);
          return;
        }
        lastFrameTime = now;

        const elapsed = now - startTime;
        const t = Math.min(1, elapsed / RECENTER_DURATION_MS);
        // ease-out cubic: 1 - (1 - t)^3. Fast initial decay,
        // gentle landing - reads smoother than linear without
        // looking sluggish at the start.
        const eased = 1 - Math.pow(1 - t, 3);
        const headYawRel = startHeadYawRel * (1 - eased);
        const pitch = startPitch * (1 - eased);
        const bodyYaw = startBodyYaw * (1 - eased);
        const headYawWorld = headYawRel + bodyYaw;
        // Same ordering invariant as the tick loop: body first,
        // then head world, so the IK never sees a head pose against
        // a stale body.
        if (Math.abs(startBodyYaw) >= 0.5) {
          bodySetter(bodyYaw);
        }
        headSetter(0, pitch, headYawWorld);

        if (t < 1) {
          window.requestAnimationFrame(raf);
        }
      };
      window.requestAnimationFrame(raf);
    };
    // We deliberately use an empty dependency array: this effect's
    // cleanup is the recenter, and re-arming it on every prop
    // change would either tear down a still-in-flight recenter
    // (bad - the head jumps mid-animation) or create overlapping
    // recenters. Mount-once / unmount-once is the right scope.
    // All dynamic state goes through refs (`headYawRelRef`,
    // `bodyYawRef`, `setHeadRpyDegRef`, `setBodyYawDegRef`) so the
    // cleanup closure stays correct without listing them as deps.
  }, []);
}
