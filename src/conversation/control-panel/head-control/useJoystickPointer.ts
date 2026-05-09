/**
 * Joystick pointer-events hook.
 *
 * Owns the touch / mouse / pen lifecycle of a virtual joystick:
 *
 *   pointerdown → start drag, capture pointer
 *   pointermove → update deflection
 *   pointerup / pointercancel → release, snap thumb home
 *
 * The hook is intentionally framework-agnostic about WHAT consumes
 * the deflection. It exposes:
 *
 *   - `deflectionRef` : a `MutableRefObject<{ x: number; y: number }>`
 *     normalised to `[-1, 1]` (deadzone applied). Read this from
 *     a `setInterval` / `requestAnimationFrame` loop (typically
 *     `useHeadVelocityControl`) to drive a control surface without
 *     triggering React re-renders on every move.
 *
 *   - `isActive` : a React state that flips `true` while the user
 *     is actively dragging, used by the visual to scale up / boost
 *     opacity. Re-renders are bounded to mount + drag start + drag
 *     end (3 commits per drag at most).
 *
 *   - `handlers` : pointer event handlers to spread on the ring
 *     element. The ring is the `<div>` with the geometric centre
 *     used as the origin of the deflection.
 *
 *   - `thumbStyleRef` : a callback ref attached to the thumb
 *     `<div>` so the hook can mutate `style.transform` directly
 *     (60 Hz finger tracking without React re-render).
 *
 * The hook is read-only on `disabled`: when the host flips
 * `disabled = true` mid-drag, the hook short-circuits subsequent
 * pointer events but doesn't try to reset the existing capture
 * (that's the host's call - typically it just disables the parent
 * `pointerEvents`, which lets the browser cancel naturally).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  JOYSTICK_DEADZONE,
  JOYSTICK_RING_DIAMETER_PX,
  JOYSTICK_THUMB_DIAMETER_PX,
} from './constants';

export interface JoystickPointerHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
}

export interface JoystickPointerState {
  /**
   * Latest thumb deflection in `[-1, 1]^2`. Mutated synchronously
   * inside pointer event handlers; consumers READ it from a timer
   * / rAF loop. The reference is stable across the lifetime of the
   * hook so consumers can capture it once.
   */
  deflectionRef: React.MutableRefObject<{ x: number; y: number }>;
  /** True while the user is actively dragging the thumb. */
  isActive: boolean;
  /** Pointer event handlers to attach to the joystick ring element. */
  handlers: JoystickPointerHandlers;
  /**
   * Attach to the thumb `<div>` via React's `ref` prop. The hook
   * mutates the thumb's `transform` directly on every move, so the
   * thumb tracks the finger at native frame rate without any React
   * re-renders.
   */
  thumbRef: React.RefCallback<HTMLDivElement>;
}

export interface UseJoystickPointerOptions {
  /**
   * When `true`, pointer events are ignored (no drag start, no
   * deflection updates). The thumb stays at home, `isActive` stays
   * `false`, and `deflectionRef.current` is reset to `{x:0, y:0}`.
   *
   * The host typically sets this from the engine's "isLive" state -
   * we don't want to issue head commands before the session is
   * actually ready, and we don't want a half-active joystick
   * lingering after a disconnect.
   */
  disabled: boolean;
}

const HOME_TRANSFORM = 'translate3d(-50%, -50%, 0)';

const RING_RADIUS = JOYSTICK_RING_DIAMETER_PX / 2;
/**
 * The thumb is centred on the ring origin via a base
 * `translate(-50%, -50%)`; deflection is added on top in PIXELS
 * proportional to the visual radius (ring radius minus thumb
 * radius), so a full deflection visually lands the thumb at the
 * inner edge of the ring without overshooting.
 */
const VISUAL_RADIUS_PX = RING_RADIUS - JOYSTICK_THUMB_DIAMETER_PX / 2;

export function useJoystickPointer({
  disabled,
}: UseJoystickPointerOptions): JoystickPointerState {
  const deflectionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isActive, setIsActive] = useState(false);

  // Dragging context, kept in refs (not state) so changes don't
  // re-render the joystick component on every pointer move.
  const activePointerIdRef = useRef<number | null>(null);
  const ringCentreRef = useRef<{ x: number; y: number } | null>(null);

  // Thumb DOM ref. Set via the callback ref returned below; we
  // mutate `style.transform` directly to track the finger.
  const thumbDomRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useCallback((node: HTMLDivElement | null) => {
    thumbDomRef.current = node;
    // Always paint the home transform on (re)attach so a quick
    // re-mount during HMR doesn't strand the thumb on a stale
    // offset.
    if (node) node.style.transform = HOME_TRANSFORM;
  }, []);

  /**
   * Apply the current `(x, y)` deflection (in `[-1, 1]^2`) to BOTH
   * the deflection ref and the thumb's CSS transform. Centralised so
   * pointer move and pointer up follow the exact same write path -
   * critical to ensure the thumb's home reset on release matches
   * the deflection reset (otherwise a release with non-zero
   * deflection would visually snap home but the controller would
   * keep integrating until the next control tick).
   */
  const applyDeflection = useCallback((x: number, y: number) => {
    deflectionRef.current = { x, y };
    const thumb = thumbDomRef.current;
    if (!thumb) return;
    if (x === 0 && y === 0) {
      thumb.style.transform = HOME_TRANSFORM;
      return;
    }
    const px = x * VISUAL_RADIUS_PX;
    const py = y * VISUAL_RADIUS_PX;
    thumb.style.transform = `translate3d(calc(${px}px - 50%), calc(${py}px - 50%), 0)`;
  }, []);

  /**
   * Pure deadzone application: if the magnitude is below the
   * configured threshold, snap to zero. Otherwise keep the value.
   * We intentionally don't rescale the post-deadzone region (some
   * implementations remap `[deadzone, 1]` to `[0, 1]` for "no dead
   * spot at the edge of deadzone"); the quadratic curve applied
   * downstream by the controller already softens the transition,
   * so a plain snap reads as smooth here.
   */
  const applyDeadzone = useCallback((x: number, y: number) => {
    const magnitude = Math.hypot(x, y);
    if (magnitude < JOYSTICK_DEADZONE) return { x: 0, y: 0 };
    return { x, y };
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      // Only react to the primary button on mouse / pen; touch
      // always reports button 0 anyway.
      if (event.button !== 0 && event.pointerType === 'mouse') return;

      // Capture so we keep getting move/up events even if the
      // pointer slides off the ring during a fast push.
      const ring = event.currentTarget;
      ring.setPointerCapture(event.pointerId);
      activePointerIdRef.current = event.pointerId;

      // Cache the ring's centre at drag-start. Recomputing on
      // every move would catch layout shifts (rare during a single
      // drag) but cost a `getBoundingClientRect` per move.
      const rect = ring.getBoundingClientRect();
      ringCentreRef.current = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };

      setIsActive(true);
      // Snap deflection to the touch position immediately so the
      // thumb visually jumps to under the finger rather than
      // waiting for the first move.
      handleMove(event.clientX, event.clientY);
      // Stop the gesture from bubbling to ancestors that might
      // also handle pointerdown (e.g. a sibling that owns swipe
      // navigation).
      event.stopPropagation();
    },
    // `handleMove` is stable (defined below in the same scope via
    // a ref-trampoline), but eslint doesn't see that without an
    // explicit comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabled],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (event.pointerId !== activePointerIdRef.current) return;
      handleMove(event.clientX, event.clientY);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabled],
  );

  /**
   * Common move handler: invoked on `pointerdown` (initial snap)
   * and `pointermove`. Lives outside the React callback identity
   * via a ref so the two callbacks stay reference-stable for the
   * entire drag.
   */
  const handleMove = (clientX: number, clientY: number) => {
    const centre = ringCentreRef.current;
    if (!centre) return;
    const dx = clientX - centre.x;
    const dy = clientY - centre.y;
    // Normalise to `[-1, 1]^2`, clamped to the ring's circular
    // bound so a drag well past the edge doesn't keep growing.
    const magnitude = Math.hypot(dx, dy);
    const clampedMagnitude = Math.min(magnitude, RING_RADIUS);
    const normalisedX =
      magnitude === 0 ? 0 : (dx / magnitude) * (clampedMagnitude / RING_RADIUS);
    const normalisedY =
      magnitude === 0 ? 0 : (dy / magnitude) * (clampedMagnitude / RING_RADIUS);

    const after = applyDeadzone(normalisedX, normalisedY);
    applyDeflection(after.x, after.y);
  };

  const releaseDrag = useCallback(() => {
    activePointerIdRef.current = null;
    ringCentreRef.current = null;
    setIsActive(false);
    applyDeflection(0, 0);
  }, [applyDeflection]);

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerId !== activePointerIdRef.current) return;
      releaseDrag();
    },
    [releaseDrag],
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerId !== activePointerIdRef.current) return;
      releaseDrag();
    },
    [releaseDrag],
  );

  // Hard reset on disable so a `disabled` flip mid-drag (e.g. the
  // engine going from `ready` to `error`) doesn't leave the
  // controller integrating a stale deflection on the next tick.
  useEffect(() => {
    if (!disabled) return;
    activePointerIdRef.current = null;
    ringCentreRef.current = null;
    if (isActive) setIsActive(false);
    applyDeflection(0, 0);
    // Intentionally not depending on `isActive`/`applyDeflection`
    // identities: we want this effect to fire ONLY when `disabled`
    // toggles on, not in response to internal state churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  return {
    deflectionRef,
    isActive,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
    thumbRef,
  };
}
