/**
 * Generic virtual joystick - "naked" puck + optional micro-label.
 *
 *   ╭──╮      ← glass ring + solid thumb
 *   │··│
 *   ╰──╯
 *    HEAD     ← micro-label, white w/ shadow
 *
 * Layout-agnostic and motion-agnostic: it only renders the visual and
 * wires the pointer (+ optional gamepad) input into a deflection ref.
 * The caller hands its control loop that ref via `onDeflectionRef` and
 * reads `.current` every tick ({x, y} in the unit disk, +x = right,
 * +y = DOWN). Positioning comes from `sx`.
 *
 * Designed to OVERLAY a full-screen live camera feed, so every surface
 * has to read on top of arbitrary imagery: translucent dark glass ring
 * with a hairline light border, solid thumb, white label with a
 * text-shadow.
 */
import type React from 'react';
import { useEffect } from 'react';
import type { SxProps, Theme } from '@mui/material';
import { Box, Typography } from '@mui/material';

import MoveIcon from './MoveIcon';
import { useGamepadDeflection } from './useGamepadDeflection';
import { useJoystickPointer } from './useJoystickPointer';

export interface JoystickProps {
  /** Receives the live deflection ref once (stable object); the caller's control loop reads `.current` every tick. */
  onDeflectionRef: (ref: React.RefObject<{ x: number; y: number }>) => void;
  enabled: boolean;
  /** Micro-label under the puck, e.g. "Head" / "Wheels". */
  label?: string;
  /** Label override when disabled (e.g. "Waking up…"). */
  disabledLabel?: string;
  /** Ring diameter in px, default 128. Thumb = round(ring * 0.34). */
  size?: number;
  /** Which physical gamepad stick also drives this puck; null = none. Default null. */
  gamepadStick?: 'left' | 'right' | 'any' | null;
  /** Glyph drawn on the thumb; defaults to <MoveIcon/>. */
  thumbIcon?: React.ReactNode;
  /** Thumb colour override (defaults to theme primary.main). */
  thumbColor?: string;
  sx?: SxProps<Theme>;
  /** Optional node rendered absolutely next to the ring (e.g. a recenter button); the Joystick positions nothing itself, caller passes an absolutely positioned node. */
  children?: React.ReactNode;
}

const DEFAULT_RING_DIAMETER_PX = 128;
const THUMB_RATIO = 0.34;
/** Glyph size relative to the thumb. */
const ICON_RATIO = 0.55;
const DISABLED_OPACITY = 0.45;

export default function Joystick({
  onDeflectionRef,
  enabled,
  label,
  disabledLabel,
  size = DEFAULT_RING_DIAMETER_PX,
  gamepadStick = null,
  thumbIcon,
  thumbColor,
  sx,
  children,
}: JoystickProps) {
  const ringDiameter = size;
  const thumbDiameter = Math.round(size * THUMB_RATIO);

  const pointer = useJoystickPointer({
    disabled: !enabled,
    ringDiameter,
    thumbDiameter,
  });

  // A paired game controller drives the same puck/deflection as touch.
  // It yields to a live finger drag (see the hook) so the two never
  // contend over `pointer.deflectionRef`.
  useGamepadDeflection({
    enabled: enabled && gamepadStick !== null,
    setDeflection: pointer.setDeflection,
    isPointerActiveRef: pointer.isActiveRef,
    stick: gamepadStick ?? 'any',
  });

  // The ref object is stable for the component's lifetime, so handing
  // it over once on mount is enough; a re-created callback on the
  // caller side must not re-fire it.
  useEffect(() => {
    onDeflectionRef(pointer.deflectionRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const caption = enabled ? label : (disabledLabel ?? label);

  return (
    <Box
      sx={[
        {
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1,
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      <Box
        role="presentation"
        aria-hidden={!enabled}
        onPointerDown={pointer.handlers.onPointerDown}
        onPointerMove={pointer.handlers.onPointerMove}
        onPointerUp={pointer.handlers.onPointerUp}
        onPointerCancel={pointer.handlers.onPointerCancel}
        sx={(theme) => ({
          position: 'relative',
          width: ringDiameter,
          height: ringDiameter,
          borderRadius: '50%',
          // Dark glass: legible on bright AND dark video frames.
          background: 'rgba(0, 0, 0, 0.35)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          border: `1px solid ${
            pointer.isActive ? 'rgba(255, 255, 255, 0.45)' : 'rgba(255, 255, 255, 0.25)'
          }`,
          boxShadow: '0 6px 20px -8px rgba(0, 0, 0, 0.5)',
          opacity: enabled ? 1 : DISABLED_OPACITY,
          transition: theme.transitions.create(['opacity', 'border-color'], {
            duration: theme.transitions.duration.shortest,
          }),
          // No browser scroll / zoom gestures on the drag area.
          touchAction: 'none',
          pointerEvents: enabled ? 'auto' : 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        })}
      >
        <Box
          ref={pointer.thumbRef}
          sx={(theme) => ({
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: thumbDiameter,
            height: thumbDiameter,
            borderRadius: '50%',
            // `transform` is owned by the pointer hook (imperative,
            // per-frame) - never set it here.
            background: thumbColor ?? theme.palette.primary.main,
            color: '#fff',
            boxShadow: pointer.isActive
              ? '0 4px 14px -2px rgba(0, 0, 0, 0.6)'
              : '0 2px 8px -1px rgba(0, 0, 0, 0.45)',
            transition: theme.transitions.create('box-shadow', {
              duration: theme.transitions.duration.shortest,
            }),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            // Size any SvgIcon glyph (default or caller-provided).
            '& .MuiSvgIcon-root': {
              fontSize: thumbDiameter * ICON_RATIO,
            },
          })}
        >
          {thumbIcon ?? <MoveIcon />}
        </Box>
      </Box>

      {children}

      {caption ? (
        <Typography
          aria-hidden
          sx={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '1.2px',
            textTransform: 'uppercase',
            color: '#fff',
            textShadow: '0 1px 3px rgba(0, 0, 0, 0.7)',
            // Slightly brighter when forced-disabled with a status
            // label - the user needs to actually READ it.
            opacity: enabled ? 0.9 : disabledLabel ? 0.85 : 0.55,
            transition: 'opacity 200ms ease',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            pointerEvents: 'none',
            lineHeight: 1,
          }}
        >
          {caption}
        </Typography>
      ) : null}
    </Box>
  );
}
