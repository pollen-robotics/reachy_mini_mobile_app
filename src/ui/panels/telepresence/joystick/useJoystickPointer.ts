/**
 * Joystick pointer-events hook.
 *
 * Owns the touch / mouse / pen drag lifecycle. Exposes a deflection ref
 * (mutable, read by the caller's control loop every tick), a React
 * `isActive` flag for visual styling, the event handlers to attach to
 * the joystick ring, and a callback ref for the thumb (so the hook can
 * mutate `style.transform` at native frame rate without re-rendering).
 *
 * Deflection lives in the unit disk: +x = right, +y = DOWN (screen
 * convention). It is reset to `{0, 0}` on release / cancel and whenever
 * `disabled` flips to true.
 */
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { computeDeflection, JOYSTICK_DEADZONE } from './deflection';

export interface JoystickPointerHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
}

export interface JoystickPointerState {
  deflectionRef: React.RefObject<{ x: number; y: number }>;
  isActive: boolean;
  /**
   * Mutable mirror of `isActive`, readable from a non-React loop (e.g.
   * the gamepad poller) without forcing a re-subscription. The pad uses
   * it to yield to a live touch drag.
   */
  isActiveRef: React.RefObject<boolean>;
  /**
   * Imperatively set the deflection (updates the ref read by the
   * control loop AND moves the thumb visual). Exposed so an external
   * input source (gamepad) can drive the same puck the pointer does,
   * keeping a single source of truth for both the command value and
   * the on-screen position.
   */
  setDeflection: (x: number, y: number) => void;
  handlers: JoystickPointerHandlers;
  thumbRef: React.RefCallback<HTMLDivElement>;
}

export interface UseJoystickPointerOptions {
  disabled: boolean;
  /** Ring diameter in px (the drag area). */
  ringDiameter: number;
  /** Thumb diameter in px; bounds how far the thumb visual travels. */
  thumbDiameter: number;
  /** Radial deadzone as a fraction of the ring radius. Default 0.1. */
  deadzone?: number;
}

const HOME_TRANSFORM = 'translate3d(-50%, -50%, 0)';

export function useJoystickPointer({
  disabled,
  ringDiameter,
  thumbDiameter,
  deadzone = JOYSTICK_DEADZONE,
}: UseJoystickPointerOptions): JoystickPointerState {
  const deflectionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isActive, setIsActive] = useState(false);
  const isActiveRef = useRef(false);

  const activePointerIdRef = useRef<number | null>(null);
  const ringCentreRef = useRef<{ x: number; y: number } | null>(null);

  // Geometry in a ref so the (stable) handlers always see the latest
  // size without being re-created on every resize.
  const ringRadius = ringDiameter / 2;
  // The thumb's centre may travel until its edge touches the ring edge.
  const visualRadius = Math.max(0, ringRadius - thumbDiameter / 2);
  const geometryRef = useRef({ ringRadius, visualRadius, deadzone });
  geometryRef.current = { ringRadius, visualRadius, deadzone };

  const thumbDomRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useCallback((node: HTMLDivElement | null) => {
    thumbDomRef.current = node;
    if (node) node.style.transform = HOME_TRANSFORM;
  }, []);

  const applyDeflection = useCallback((x: number, y: number) => {
    deflectionRef.current = { x, y };
    const thumb = thumbDomRef.current;
    if (!thumb) return;
    if (x === 0 && y === 0) {
      thumb.style.transform = HOME_TRANSFORM;
      return;
    }
    const r = geometryRef.current.visualRadius;
    const px = x * r;
    const py = y * r;
    thumb.style.transform = `translate3d(calc(${px}px - 50%), calc(${py}px - 50%), 0)`;
  }, []);

  // Re-place the thumb if the size changes mid-deflection (e.g. a
  // gamepad is holding the puck while the layout resizes).
  useEffect(() => {
    const { x, y } = deflectionRef.current;
    applyDeflection(x, y);
  }, [visualRadius, applyDeflection]);

  const handleMove = useCallback(
    (clientX: number, clientY: number) => {
      const centre = ringCentreRef.current;
      if (!centre) return;
      const { ringRadius: radius, deadzone: dz } = geometryRef.current;
      const d = computeDeflection(
        clientX - centre.x,
        clientY - centre.y,
        radius,
        dz,
      );
      applyDeflection(d.x, d.y);
    },
    [applyDeflection],
  );

  const releaseDrag = useCallback(() => {
    activePointerIdRef.current = null;
    ringCentreRef.current = null;
    isActiveRef.current = false;
    setIsActive(false);
    applyDeflection(0, 0);
  }, [applyDeflection]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      // Primary mouse button only; touch / pen always pass.
      if (event.button !== 0 && event.pointerType === 'mouse') return;

      // A second finger on the same ring takes over (the first one's
      // `pointerup` is then ignored by the id check below).
      const ring = event.currentTarget;
      // Keep receiving move/up even when the finger leaves the ring.
      ring.setPointerCapture(event.pointerId);
      activePointerIdRef.current = event.pointerId;

      const rect = ring.getBoundingClientRect();
      ringCentreRef.current = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };

      isActiveRef.current = true;
      setIsActive(true);
      handleMove(event.clientX, event.clientY);
      event.stopPropagation();
    },
    [disabled, handleMove],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (event.pointerId !== activePointerIdRef.current) return;
      handleMove(event.clientX, event.clientY);
    },
    [disabled, handleMove],
  );

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

  // Disabling mid-drag must drop the command immediately, not wait for
  // the finger to lift.
  useEffect(() => {
    if (disabled) releaseDrag();
  }, [disabled, releaseDrag]);

  // Unmounted mid-drag (tab exit with a thumb still down): zero the
  // deflection so a control loop still holding the ref stops moving.
  useEffect(() => () => {
    deflectionRef.current = { x: 0, y: 0 };
  }, []);

  return {
    deflectionRef,
    isActive,
    isActiveRef,
    setDeflection: applyDeflection,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
    thumbRef,
  };
}
