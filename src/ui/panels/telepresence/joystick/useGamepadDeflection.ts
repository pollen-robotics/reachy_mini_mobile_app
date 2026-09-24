/**
 * Feed a paired game controller's stick into a joystick's deflection,
 * so telepresence steering works with an Xbox / PS controller (or any
 * Gamepad-API device) paired to the phone or desktop.
 *
 * Coexistence with touch
 * ──────────────────────
 * The on-screen joystick (`useJoystickPointer`) stays the primary input.
 * While the user is actively dragging the puck (`isPointerActiveRef.
 * current === true`) the gamepad is ignored, so the two never fight over
 * the same `deflectionRef`. The instant the user lifts their finger, the
 * pad resumes control. Releasing the stick recentres the puck exactly
 * like releasing it by touch (we write `{0,0}` once on the active → idle
 * transition, then go quiet so we don't stomp the pointer's resting
 * state every frame).
 *
 * Stick choice + sign convention
 * ──────────────────────────────
 * `stick` selects the left stick (axes[0], axes[1]), the right stick
 * (axes[2], axes[3]) or `'any'`: read both and keep whichever has the
 * larger magnitude, so the operator can steer with either thumb. The
 * Gamepad API's axis convention (right = +x, up = -y) is exactly the
 * puck's screen convention (+y = down), so raw axes map straight onto
 * the deflection with no sign flips. A radial deadzone is applied and
 * rescaled (see `deflection.ts`).
 */
import type React from 'react';
import { useEffect, useRef } from 'react';

import { applyRadialDeadzone, GAMEPAD_DEADZONE } from './deflection';

export type GamepadStick = 'left' | 'right' | 'any';

export interface UseGamepadDeflectionOptions {
  /** Same gate as the joystick: only steer when the robot is live + awake. */
  enabled: boolean;
  /** Pointer hook's imperative setter (updates the ref AND the thumb). */
  setDeflection: (x: number, y: number) => void;
  /** Pointer hook's live-active mirror; the pad yields to a touch drag. */
  isPointerActiveRef: React.RefObject<boolean>;
  /** Which physical stick drives this puck. Default `'any'`. */
  stick?: GamepadStick;
}

/**
 * Read the most-deflected selected stick across all connected pads,
 * apply the radial deadzone, and return a normalised `{x, y}` in the
 * unit disk. Returns `{0, 0}` when nothing is connected or every stick
 * is centred.
 */
function readStickDeflection(stick: GamepadStick): { x: number; y: number } {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let bestX = 0;
  let bestY = 0;
  let bestMag = 0;

  for (const pad of pads) {
    if (!pad || !pad.connected || !pad.axes) continue;
    const sticks: Array<readonly [number, number]> = [];
    if (stick !== 'right') sticks.push([pad.axes[0] ?? 0, pad.axes[1] ?? 0]);
    if (stick !== 'left') sticks.push([pad.axes[2] ?? 0, pad.axes[3] ?? 0]);
    for (const [x, y] of sticks) {
      const mag = Math.hypot(x, y);
      if (mag > bestMag) {
        bestMag = mag;
        bestX = x;
        bestY = y;
      }
    }
  }

  return applyRadialDeadzone(bestX, bestY, GAMEPAD_DEADZONE);
}

export function useGamepadDeflection({
  enabled,
  setDeflection,
  isPointerActiveRef,
  stick = 'any',
}: UseGamepadDeflectionOptions): void {
  // Keep the latest setter readable from the rAF loop without retearing
  // the loop on every render (the callback identity is stable today, but
  // the ref keeps us honest if that changes).
  const setDeflectionRef = useRef(setDeflection);
  useEffect(() => {
    setDeflectionRef.current = setDeflection;
  }, [setDeflection]);

  useEffect(() => {
    if (!enabled) return undefined;
    if (typeof navigator === 'undefined' || !navigator.getGamepads) {
      return undefined;
    }

    let rafId = 0;
    // Whether the pad wrote a non-zero deflection on the previous frame.
    // Drives the single "back to neutral" write on release.
    let wasDriving = false;

    const tick = () => {
      rafId = window.requestAnimationFrame(tick);

      // A live touch drag owns the puck; stand down entirely.
      if (isPointerActiveRef.current) {
        wasDriving = false;
        return;
      }

      const { x, y } = readStickDeflection(stick);
      const driving = x !== 0 || y !== 0;

      if (driving) {
        setDeflectionRef.current(x, y);
        wasDriving = true;
      } else if (wasDriving) {
        // Stick just returned to centre - recentre the puck once, then
        // go quiet so the pointer's resting `{0,0}` isn't overwritten on
        // every idle frame.
        setDeflectionRef.current(0, 0);
        wasDriving = false;
      }
    };

    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
      // Loop torn down (disabled, stick remapped, unmount) while the pad
      // was holding the puck: don't leave a stale deflection behind.
      if (wasDriving) setDeflectionRef.current(0, 0);
    };
  }, [enabled, isPointerActiveRef, stick]);
}
