/**
 * Head joystick overlay.
 *
 * Public-facing component for the manual head control surface.
 * Composes the visual `<Joystick>`, the pointer hook, and the
 * velocity controller into a single drop-in element that the host
 * positions wherever it wants - typically as an absolute-positioned
 * overlay on top of the robot's camera feed:
 *
 *   <Box position="relative">
 *     <VideoFeed session={session} />
 *     <HeadJoystickOverlay session={session} enabled={isLive} />
 *   </Box>
 *
 * The overlay is intentionally NOT aware of the camera or any
 * other UI - it's a self-contained control surface that any caller
 * can drop on any positioning context.
 *
 * Layout: anchored bottom-right with safe-area-aware insets so the
 * joystick stays clear of the iOS home indicator / Android nav bar
 * if the host happens to span the full viewport.
 *
 * Lifecycle: mounting starts the control loop (subject to
 * `enabled`), unmounting triggers the recenter animation. Toggling
 * `enabled` does not recenter - that's reserved for navigation away.
 */
import { Box, Typography } from '@mui/material';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';
import Joystick from './Joystick';
import { useHeadVelocityControl } from './useHeadVelocityControl';
import { useJoystickPointer } from './useJoystickPointer';

export interface HeadJoystickOverlayProps {
  /**
   * Slice of the session the overlay needs. Typed via `Pick` so
   * the dependency surface is explicit at the call site - the
   * overlay only needs the head setter.
   */
  session: Pick<RobotSessionHandle, 'setHeadRpyDeg'>;
  /**
   * When `true`, the joystick is interactive and the velocity
   * controller's tick timer is running. When `false`, the visual
   * is faded out, pointer events are ignored, and the integration
   * state is reset.
   *
   * Caller responsibility: only enable when the session is
   * actually ready (`hasReachedReady`) AND the robot is not in an
   * autonomous motion that the user shouldn't override (wake_up,
   * sleep, dance). The overlay doesn't try to introspect those
   * itself - it'd require pulling more of the session handle.
   */
  enabled: boolean;
  /**
   * Optional offset from the bottom-right corner of the host
   * positioning context. Defaults are tuned for the camera feed
   * frame: `bottom: 12, right: 12` clears the LIVE pip and the
   * camera's rounded corners while keeping a comfortable thumb
   * reach.
   */
  bottom?: number | string;
  right?: number | string;
}

const DEFAULT_BOTTOM = 12;
const DEFAULT_RIGHT = 12;

export default function HeadJoystickOverlay({
  session,
  enabled,
  bottom = DEFAULT_BOTTOM,
  right = DEFAULT_RIGHT,
}: HeadJoystickOverlayProps) {
  const pointer = useJoystickPointer({ disabled: !enabled });
  useHeadVelocityControl({
    deflectionRef: pointer.deflectionRef,
    setHeadRpyDeg: session.setHeadRpyDeg,
    enabled,
  });

  return (
    <Box
      sx={{
        position: 'absolute',
        bottom,
        right,
        // Sit above the LIVE pip / camera fallback so the joystick
        // is always reachable even on a black-frame state.
        zIndex: 3,
        // Vertical stack: ring on top, "Head" affordance label
        // below, both centred. The label sits OUTSIDE the ring so
        // it doesn't compete with the moving thumb / OpenWith
        // glyph - and it gives the user a one-word answer to
        // "what does this drag?".
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.5,
        // Pointer events flow through to the ring's container;
        // the disabled fade is handled inside `<Joystick>` via
        // `pointerEvents: none` on its root when disabled.
      }}
    >
      <Joystick
        handlers={pointer.handlers}
        thumbRef={pointer.thumbRef}
        isActive={pointer.isActive}
        disabled={!enabled}
      />
      <Typography
        aria-hidden
        sx={{
          fontSize: TYPO.micro,
          fontWeight: FONT_WEIGHT.semibold,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          // White-ish text with a subtle dark text-shadow so it
          // stays legible on whatever the camera shows behind
          // (bright window, dark wall, busy desk). Doesn't lean
          // on the theme palette because this label sits on top
          // of a video stream, not a card surface.
          color: 'rgba(255, 255, 255, 0.95)',
          textShadow:
            '0 1px 3px rgba(0, 0, 0, 0.7), 0 0 1px rgba(0, 0, 0, 0.6)',
          opacity: enabled ? 1 : 0.4,
          transition: 'opacity 200ms ease',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          // Don't intercept pointer events: the joystick ring
          // owns interaction; the label is purely decorative.
          pointerEvents: 'none',
          lineHeight: 1,
        }}
      >
        Head
      </Typography>
    </Box>
  );
}
