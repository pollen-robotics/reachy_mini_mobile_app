/**
 * Head velocity controller.
 *
 * Translates a normalised joystick deflection (`[-1, 1]^2`) into a
 * stream of `setHeadRpyDeg` commands at a bounded rate, integrating
 * the deflection into a yaw/pitch state clamped to soft limits.
 *
 * Architecture
 * ────────────
 *
 *   joystick deflection (ref)  ←  pointer events (read at 20 Hz)
 *           │
 *           ▼
 *   quadratic curve  + sign mapping  +  scale by MAX *_DEG_PER_SEC
 *           │
 *           ▼
 *   integrate over 50 ms  →  clamp to soft limits  →  yaw/pitch state
 *           │
 *           ▼
 *   send `setHeadRpyDeg` if delta exceeds threshold
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
 * Quadratic curve
 * ───────────────
 * `velocity ∝ deflection²` (sign preserved). At the centre of the
 * stick the head barely moves (precision); near the edge it
 * sweeps fast (coverage). Same maths the desktop's `useMouseDrift`
 * would use for camera control.
 *
 * Recenter on unmount
 * ───────────────────
 * When the host unmounts the controller (typically because the
 * user navigated away from the Robot tab), the hook spawns a
 * fire-and-forget rAF loop that interpolates the last commanded
 * yaw/pitch back to `(0, 0)` over `RECENTER_DURATION_MS`. The
 * loop survives the React unmount: it captures the session
 * setter and the initial state into local closures, then runs to
 * completion independently. This is the v1 implementation of "head
 * recenters as you leave the tab" - cheap, no extra plumbing
 * needed in `useRobotSession`.
 */
import { useEffect, useRef } from 'react';

import {
  CONTROL_TICK_MS,
  HEAD_PITCH_MAX_DEG,
  HEAD_PITCH_MIN_DEG,
  HEAD_YAW_LIMIT_DEG,
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
  enabled,
}: UseHeadVelocityControlOptions): void {
  /**
   * Integrated head state. Refs (not state) because we don't want
   * to re-render React on every tick - the joystick visual is
   * driven by the deflection directly, the head state lives only
   * to be sent to the robot.
   */
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  /**
   * Last commanded values, used by the threshold gate to skip
   * redundant `setHeadRpyDeg` calls when the integration produced
   * a sub-threshold delta (typically while the joystick sits in
   * the deadzone).
   */
  const lastCommandedYawRef = useRef(Number.POSITIVE_INFINITY);
  const lastCommandedPitchRef = useRef(Number.POSITIVE_INFINITY);
  /**
   * Pinned reference to the latest setter so the recenter loop on
   * unmount can keep firing commands after the React closure that
   * created it has been disposed.
   */
  const setHeadRpyDegRef = useRef(setHeadRpyDeg);
  useEffect(() => {
    setHeadRpyDegRef.current = setHeadRpyDeg;
  }, [setHeadRpyDeg]);

  // Active control loop. Runs only while `enabled === true`.
  useEffect(() => {
    if (!enabled) {
      // Hard reset so a re-enable doesn't carry over stale state.
      yawRef.current = 0;
      pitchRef.current = 0;
      lastCommandedYawRef.current = Number.POSITIVE_INFINITY;
      lastCommandedPitchRef.current = Number.POSITIVE_INFINITY;
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
      const yawDelta = -curveX * MAX_YAW_DEG_PER_SEC * dtSec;
      const pitchDelta = curveY * MAX_PITCH_DEG_PER_SEC * dtSec;

      const nextYaw = clamp(
        yawRef.current + yawDelta,
        -HEAD_YAW_LIMIT_DEG,
        HEAD_YAW_LIMIT_DEG,
      );
      const nextPitch = clamp(
        pitchRef.current + pitchDelta,
        HEAD_PITCH_MIN_DEG,
        HEAD_PITCH_MAX_DEG,
      );

      yawRef.current = nextYaw;
      pitchRef.current = nextPitch;

      // Threshold gate: avoid spamming the DataChannel with
      // identical commands when the joystick is in the deadzone
      // and the integration produced no meaningful change. We
      // STILL fire if the user just released after a non-zero
      // displacement (the threshold is on the *delta*, so the
      // first tick after a release goes through and lands the
      // head on the final position).
      const yawDiff = Math.abs(nextYaw - lastCommandedYawRef.current);
      const pitchDiff = Math.abs(nextPitch - lastCommandedPitchRef.current);
      if (
        yawDiff < TARGET_DELTA_THRESHOLD_DEG &&
        pitchDiff < TARGET_DELTA_THRESHOLD_DEG
      ) {
        return;
      }

      lastCommandedYawRef.current = nextYaw;
      lastCommandedPitchRef.current = nextPitch;
      setHeadRpyDegRef.current(0, nextPitch, nextYaw);
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
      const startYaw = yawRef.current;
      const startPitch = pitchRef.current;
      // Skip the recenter when nothing to recenter from. Avoids
      // a useless burst of `setHeadRpyDeg(0, 0, 0)` calls on a
      // mount/unmount with no user interaction.
      if (Math.abs(startYaw) < 0.5 && Math.abs(startPitch) < 0.5) return;

      const setter = setHeadRpyDegRef.current;
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
        const yaw = startYaw * (1 - eased);
        const pitch = startPitch * (1 - eased);
        setter(0, pitch, yaw);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
