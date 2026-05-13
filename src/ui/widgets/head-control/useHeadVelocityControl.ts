/**
 * Head + body velocity controller.
 *
 * Translates a normalised joystick deflection (`[-1, 1]^2`) into a
 * stream of `setHeadRpyDeg` + `setBodyYawDeg` commands at a bounded
 * rate, integrating the deflection into a yaw/pitch state for the
 * head and a yaw state for the base, each clamped to soft limits.
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
 *   integrate head yaw/pitch  →  clamp to head soft limits
 *           │
 *           ▼
 *   if head yaw is saturated AND joystick still pushes that way:
 *     integrate body yaw  →  clamp to body soft limit
 *           │
 *           ▼
 *   send `setHeadRpyDeg`  / `setBodyYawDeg` when delta exceeds threshold
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
 * The head only debattes ±50° in yaw - not enough to scan a whole
 * room without losing what's behind the robot. Rather than expose a
 * second control surface for the base, we treat the joystick as a
 * single "rotate the gaze" command and let the demand spill over:
 *
 *   - small / medium deflection → head moves, base idle
 *   - full deflection + held    → head saturates fast at its limit,
 *                                 base starts rotating in the same
 *                                 direction
 *
 * Concretely we check whether the head yaw integration just landed
 * on its clamp AND the joystick is still pushing toward the saturated
 * side; if so, we apply a separate `MAX_BODY_YAW_DEG_PER_SEC` curve
 * to the base. This keeps the natural pattern "head turns first, body
 * turns when head can't turn any further" that humans use when scanning.
 *
 * Quadratic curve
 * ───────────────
 * `velocity ∝ deflection²` (sign preserved). At the centre of the
 * stick the head barely moves (precision); near the edge it
 * sweeps fast (coverage). Same maths the desktop's `useMouseDrift`
 * would use for camera control. Body-yaw overflow uses the same
 * curve on the X axis - no need to bias toward "near max" because
 * the saturation gate already implies the user is at high deflection.
 *
 * Recenter on unmount
 * ───────────────────
 * When the host unmounts the controller (typically because the
 * user navigated away from the Robot tab), the hook spawns a
 * fire-and-forget rAF loop that interpolates the last commanded
 * head yaw/pitch AND body yaw back to `(0, 0)` over
 * `RECENTER_DURATION_MS`. The loop survives the React unmount: it
 * captures the session setters and the initial state into local
 * closures, then runs to completion independently. Recentering
 * the body too matches the "leave the robot in a neutral pose for
 * the next tab" promise - otherwise the conversation tab would
 * inherit whatever azimut the user happened to leave the base on.
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

export type AutomaticBodyYawCommand = (enabled: boolean) => boolean;

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
   * Pass-through to the engine's `setAutomaticBodyYawEnabled`.
   *
   * The daemon defaults to `automatic_body_yaw=True`, which makes
   * the IK silently rewrite any body_yaw target we send to keep
   * `|head_yaw - body_yaw| ≤ 65°`. That clamp is exactly what we
   * want to opt out of while the joystick is live: the user is
   * deliberately spinning the base independently of the head.
   *
   * The hook calls `setAutomaticBodyYawEnabled(false)` on every
   * transition into the enabled state and `true` on every transition
   * back out (cleanup of the same effect + a final call at the end
   * of the recenter on unmount). That keeps the daemon back in its
   * default mode for anything that runs after the joystick - dances,
   * wobblers, voice tools - all of which expect the relative-twist
   * clamp to be active.
   */
  setAutomaticBodyYawEnabled: AutomaticBodyYawCommand;
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
  setAutomaticBodyYawEnabled,
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
   * Integrated body yaw state. Kept separately so the saturation
   * gate doesn't have to share state with the head, and so the
   * recenter on unmount can interpolate both axes in parallel.
   */
  const bodyYawRef = useRef(0);
  /**
   * Last commanded values, used by the threshold gate to skip
   * redundant `setHeadRpyDeg` calls when the integration produced
   * a sub-threshold delta (typically while the joystick sits in
   * the deadzone).
   */
  const lastCommandedYawRef = useRef(Number.POSITIVE_INFINITY);
  const lastCommandedPitchRef = useRef(Number.POSITIVE_INFINITY);
  const lastCommandedBodyYawRef = useRef(Number.POSITIVE_INFINITY);
  /**
   * Pinned reference to the latest setters so the recenter loop on
   * unmount can keep firing commands after the React closure that
   * created it has been disposed.
   */
  const setHeadRpyDegRef = useRef(setHeadRpyDeg);
  const setBodyYawDegRef = useRef(setBodyYawDeg);
  const setAutomaticBodyYawEnabledRef = useRef(setAutomaticBodyYawEnabled);
  useEffect(() => {
    setHeadRpyDegRef.current = setHeadRpyDeg;
  }, [setHeadRpyDeg]);
  useEffect(() => {
    setBodyYawDegRef.current = setBodyYawDeg;
  }, [setBodyYawDeg]);
  useEffect(() => {
    setAutomaticBodyYawEnabledRef.current = setAutomaticBodyYawEnabled;
  }, [setAutomaticBodyYawEnabled]);

  // Active control loop. Runs only while `enabled === true`.
  useEffect(() => {
    if (!enabled) {
      // Hard reset so a re-enable doesn't carry over stale state.
      yawRef.current = 0;
      pitchRef.current = 0;
      bodyYawRef.current = 0;
      lastCommandedYawRef.current = Number.POSITIVE_INFINITY;
      lastCommandedPitchRef.current = Number.POSITIVE_INFINITY;
      lastCommandedBodyYawRef.current = Number.POSITIVE_INFINITY;
      return undefined;
    }

    // Take over from the daemon's automatic body-yaw IK. Without this,
    // the IK clamps every `setBodyYawDeg` command we send to keep
    // `|head_yaw - body_yaw| ≤ 65°`, so pushing the joystick all the
    // way left/right does NOT spin the base past that envelope -
    // the user just sees the head clamp and nothing else move,
    // which is the bug this whole feature is supposed to fix.
    //
    // We retry with a short exponential backoff (50/100/200/400/800 ms)
    // because the DataChannel might still be in a transient "opening"
    // state when this effect first fires - even though `enabled` only
    // flips true on `hasReachedReady`, the SDK's `_dc.readyState ===
    // 'open'` test can briefly disagree right after a session
    // re-acquire. The retry caps at ~1.5 s of total backoff, which
    // is well below any realistic moment the user could start dragging.
    const sendAutoOff = (attempt: number): void => {
      const ok = setAutomaticBodyYawEnabledRef.current(false);
      if (ok || attempt >= 5) return;
      const delay = 50 * Math.pow(2, attempt);
      window.setTimeout(() => sendAutoOff(attempt + 1), delay);
    };
    sendAutoOff(0);

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

      // Body-yaw overflow gate. Two conditions both have to hold:
      //
      //   1. the joystick is still pushing in some direction on X
      //      (curveX !== 0 after the deadzone),
      //   2. the head yaw is at (or within a small margin of) its
      //      hard stop ON THE SIDE THE USER IS PUSHING TOWARD - we
      //      don't want a still-centred-but-zero-velocity head to
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
        nextYaw <= -HEAD_YAW_LIMIT_DEG + HEAD_YAW_SATURATION_MARGIN_DEG;
      const headSaturatedLeft =
        pushingLeft &&
        nextYaw >= HEAD_YAW_LIMIT_DEG - HEAD_YAW_SATURATION_MARGIN_DEG;
      if (headSaturatedLeft || headSaturatedRight) {
        const bodyYawDelta = -curveX * MAX_BODY_YAW_DEG_PER_SEC * dtSec;
        nextBodyYaw = clamp(
          bodyYawRef.current + bodyYawDelta,
          -BODY_YAW_LIMIT_DEG,
          BODY_YAW_LIMIT_DEG,
        );
      }
      bodyYawRef.current = nextBodyYaw;

      // Threshold gate: avoid spamming the DataChannel with
      // identical commands when the joystick is in the deadzone
      // and the integration produced no meaningful change. We
      // STILL fire if the user just released after a non-zero
      // displacement (the threshold is on the *delta*, so the
      // first tick after a release goes through and lands the
      // head on the final position). Head and body are gated
      // separately so a body-only update (head fully saturated
      // and held) doesn't get rate-limited by an unchanged head
      // state, and vice-versa.
      const yawDiff = Math.abs(nextYaw - lastCommandedYawRef.current);
      const pitchDiff = Math.abs(nextPitch - lastCommandedPitchRef.current);
      const bodyYawDiff = Math.abs(
        nextBodyYaw - lastCommandedBodyYawRef.current,
      );

      if (
        yawDiff >= TARGET_DELTA_THRESHOLD_DEG ||
        pitchDiff >= TARGET_DELTA_THRESHOLD_DEG
      ) {
        lastCommandedYawRef.current = nextYaw;
        lastCommandedPitchRef.current = nextPitch;
        setHeadRpyDegRef.current(0, nextPitch, nextYaw);
      }

      if (bodyYawDiff >= TARGET_DELTA_THRESHOLD_DEG) {
        lastCommandedBodyYawRef.current = nextBodyYaw;
        setBodyYawDegRef.current(nextBodyYaw);
      }
    };

    const interval = window.setInterval(tick, CONTROL_TICK_MS);
    return () => {
      window.clearInterval(interval);
      // Restore the daemon's default automatic body-yaw clamp on
      // any transition out of the enabled state (tab change, engine
      // pause, unmount). The cleanup fires BEFORE the unmount recenter
      // - that's fine: the recenter still commands `body_yaw=0`, which
      // is well inside the relative-twist envelope anyway. Same retry
      // logic as the take-over above, in case the DC is mid-teardown
      // when the cleanup fires (we still want the daemon to land in
      // its default safe mode for whatever runs after).
      const sendAutoOn = (attempt: number): void => {
        const ok = setAutomaticBodyYawEnabledRef.current(true);
        if (ok || attempt >= 5) return;
        const delay = 50 * Math.pow(2, attempt);
        window.setTimeout(() => sendAutoOn(attempt + 1), delay);
      };
      sendAutoOn(0);
    };
  }, [enabled, deflectionRef]);

  // Recenter on unmount. Spawned outside React's lifecycle so the
  // animation can outlive the component.
  useEffect(() => {
    return () => {
      const startYaw = yawRef.current;
      const startPitch = pitchRef.current;
      const startBodyYaw = bodyYawRef.current;
      // Skip the recenter when nothing to recenter from. Avoids
      // a useless burst of `setHeadRpyDeg(0, 0, 0)` calls on a
      // mount/unmount with no user interaction.
      if (
        Math.abs(startYaw) < 0.5 &&
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
        const yaw = startYaw * (1 - eased);
        const pitch = startPitch * (1 - eased);
        const bodyYaw = startBodyYaw * (1 - eased);
        headSetter(0, pitch, yaw);
        // Only fire body commands when there's something to return -
        // skipping the no-op call keeps the DataChannel quiet for
        // the common case where the user never pushed past the head
        // saturation point.
        if (Math.abs(startBodyYaw) >= 0.5) {
          bodySetter(bodyYaw);
        }

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
    // All dynamic state goes through refs (`yawRef`, `bodyYawRef`,
    // `setHeadRpyDegRef`, `setBodyYawDegRef`) so the cleanup
    // closure stays correct without listing them as deps.
  }, []);
}
