/**
 * Joystick visual.
 *
 * Pure presentational component: a circular ring with a thumb
 * inside, both pointer-event-bound by the parent. The component
 * itself doesn't know about head control or the SDK - it only
 * exposes the geometry and reacts to `disabled` / `isActive` for
 * styling.
 *
 *   ┌──────────────┐
 *   │              │   ← outer ring (96 px), semi-transparent at rest
 *   │   ╭──╮       │     full opacity while dragging
 *   │   │··│       │
 *   │   ╰──╯       │   ← thumb (32 px), tracks the finger via
 *   │              │     direct DOM mutation (transform style)
 *   └──────────────┘
 *
 * Layout philosophy: the component is `position: absolute` inside
 * its host and centred via `bottom + right` insets. The thumb
 * inside is `position: absolute` centred on the ring's geometric
 * centre via `translate(-50%, -50%)`, then offset by pointer events
 * via the same transform (mutated by `useJoystickPointer`).
 *
 * `touchAction: 'none'` on the ring so a vertical drag on the
 * joystick doesn't end up scrolling the surrounding scroll
 * container (the Robot tab body is scrollable for the audio
 * section below; we want the joystick to own its own gestures
 * fully).
 */
import { Box } from '@mui/material';

import {
  JOYSTICK_RING_DIAMETER_PX,
  JOYSTICK_THUMB_DIAMETER_PX,
} from './constants';
import type { JoystickPointerHandlers } from './useJoystickPointer';

export interface JoystickProps {
  handlers: JoystickPointerHandlers;
  /**
   * Callback ref attached to the thumb. The owning hook mutates
   * `style.transform` on this node directly to track the finger
   * without triggering React re-renders.
   */
  thumbRef: React.RefCallback<HTMLDivElement>;
  /**
   * Drives the active styling (slightly larger thumb, full opacity
   * on the ring). Toggled by `useJoystickPointer` on drag start /
   * drag end - that's at most 2 commits per drag.
   */
  isActive: boolean;
  /**
   * When `true`, the joystick fades down and ignores touches. Used
   * to gate on engine readiness or autonomous-motion states.
   */
  disabled: boolean;
}

/**
 * Resting opacity for ring + thumb. Picked so the joystick is
 * unambiguous as an interactive element (above the camera's
 * darkest possible content) but doesn't compete with the live
 * video for attention.
 */
const RESTING_OPACITY = 0.55;
const ACTIVE_OPACITY = 1;
const DISABLED_OPACITY = 0.18;

export default function Joystick({
  handlers,
  thumbRef,
  isActive,
  disabled,
}: JoystickProps) {
  const visualOpacity = disabled
    ? DISABLED_OPACITY
    : isActive
      ? ACTIVE_OPACITY
      : RESTING_OPACITY;

  return (
    <Box
      role="presentation"
      aria-hidden={disabled}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerCancel}
      sx={(theme) => ({
        position: 'relative',
        width: JOYSTICK_RING_DIAMETER_PX,
        height: JOYSTICK_RING_DIAMETER_PX,
        borderRadius: '50%',
        // Glassy fill so the joystick reads as an overlay rather
        // than a solid puck. Backdrop blur softens whatever the
        // camera shows behind it without blocking too much of it.
        backgroundColor:
          theme.palette.mode === 'dark'
            ? 'rgba(255, 255, 255, 0.08)'
            : 'rgba(0, 0, 0, 0.18)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: `1.5px solid ${
          theme.palette.mode === 'dark'
            ? 'rgba(255, 255, 255, 0.35)'
            : 'rgba(255, 255, 255, 0.65)'
        }`,
        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
        opacity: visualOpacity,
        transition: theme.transitions.create(
          ['opacity', 'background-color', 'transform'],
          { duration: theme.transitions.duration.shortest },
        ),
        // Disable scroll/pan/zoom gestures on this surface; the
        // ring fully owns pointer interaction.
        touchAction: 'none',
        // Block pointer interactions when disabled. We could rely
        // on `isPointerDown` short-circuiting in the hook, but
        // setting `pointerEvents: none` makes the disabled state
        // also ignore hover / context menu / drag attempts at the
        // browser level - cleaner.
        pointerEvents: disabled ? 'none' : 'auto',
        // User-select off so a long-press / accidental drag doesn't
        // also start a text selection on the page.
        userSelect: 'none',
        WebkitUserSelect: 'none',
      })}
    >
      {/* Thumb. Always rendered at the geometric centre via the
          base `translate(-50%, -50%)` baked into the home
          transform; the hook adds an offset via direct
          `style.transform` mutation on every pointer move. */}
      <Box
        ref={thumbRef}
        sx={(theme) => ({
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: JOYSTICK_THUMB_DIAMETER_PX,
          height: JOYSTICK_THUMB_DIAMETER_PX,
          borderRadius: '50%',
          // Brighter than the ring so it reads as the actionable
          // element. White-ish on both themes for contrast against
          // the typical (dark) camera content.
          backgroundColor:
            theme.palette.mode === 'dark'
              ? 'rgba(255, 255, 255, 0.85)'
              : 'rgba(255, 255, 255, 0.95)',
          boxShadow: '0 2px 6px rgba(0, 0, 0, 0.35)',
          // Slightly grow on active to reinforce the feedback
          // already given by the ring opacity. The base transform
          // (centring + deflection) is set imperatively by the
          // hook, so this `scale` lives ONLY in the active class -
          // we layer it via `willChange` + a separate CSS variable
          // would be ideal but the hook would need to know about
          // it. Simpler: skip scale on active, the opacity ramp is
          // already enough feedback. Kept here as a comment in
          // case we want to revisit.
          transition: theme.transitions.create(['background-color'], {
            duration: theme.transitions.duration.shortest,
          }),
          pointerEvents: 'none',
        })}
      />
    </Box>
  );
}
