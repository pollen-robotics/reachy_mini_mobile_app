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
import { Box } from '@mui/material';

import type { RobotSessionHandle } from '@/session/useRobotSession';
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
    </Box>
  );
}
