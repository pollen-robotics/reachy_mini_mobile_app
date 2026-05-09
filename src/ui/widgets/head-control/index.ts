/**
 * Head control module.
 *
 * Public surface: a drop-in `HeadJoystickOverlay` that lets the
 * user manually steer the robot's head (yaw + pitch) via a virtual
 * joystick. Designed to be anchored over the camera feed in the
 * mobile app's Robot tab, but positioning-agnostic: the overlay
 * uses absolute positioning relative to its host.
 *
 * Internals (hooks, visual sub-components, constants) are kept
 * private to the module to keep the public surface small and the
 * coupling shallow.
 */
export { default as HeadJoystickOverlay } from './HeadJoystickOverlay';
export type { HeadJoystickOverlayProps } from './HeadJoystickOverlay';
