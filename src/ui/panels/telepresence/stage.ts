/**
 * Landscape stage geometry for the telepresence tab.
 *
 * The app is locked to portrait natively (Info.plist + Android manifest),
 * but the robot camera is a 16:9 landscape feed: cover-fit in a portrait
 * column only showed ~a quarter of its width. So the telepresence layer
 * is always laid out landscape, and on a portrait viewport the whole
 * stage is rotated a quarter turn clockwise with CSS. The operator turns
 * the phone counter-clockwise (notch on the left, home indicator on the
 * right), the same way they'd hold it for a video.
 *
 * A CSS rotation does not change what the platform reports: pointer
 * `clientX/Y` and `getBoundingClientRect()` stay in SCREEN space. Every
 * control that turns a finger position into a value (joystick, sliders)
 * has to map screen deltas back into the stage frame with
 * `screenToStageDelta`, and anything MUI portals (drawers) must portal
 * into the stage, not `document.body`, or it renders unrotated.
 *
 * Safe areas move with the rotation too: lay out against `STAGE_INSET`
 * (CSS variables set on the stage), never `LAYOUT.safeAreaTop/Bottom`.
 */
import { createContext, useContext } from 'react';

import { LAYOUT } from '@/ui/design/tokens';

/** Clockwise rotation applied to the stage, in degrees. */
export type StageRotation = 0 | 90;

type Side = 'top' | 'right' | 'bottom' | 'left';

export interface StageContextValue {
  rotation: StageRotation;
  /** The rotated element, used as the portal container of drawers. */
  container: HTMLElement | null;
}

/** Safe-area inset of each side of the STAGE frame, as CSS lengths. */
export const STAGE_INSET: Record<Side, string> = {
  top: 'var(--stage-inset-top)',
  right: 'var(--stage-inset-right)',
  bottom: 'var(--stage-inset-bottom)',
  left: 'var(--stage-inset-left)',
};

const INSET_LEFT = 'var(--inset-left, env(safe-area-inset-left, 0px))';
const INSET_RIGHT = 'var(--inset-right, env(safe-area-inset-right, 0px))';

/**
 * Values of the `STAGE_INSET` variables, set on the stage element.
 * Rotated clockwise, the stage's left edge lies along the portrait top
 * (notch / status bar) and its right edge along the portrait bottom
 * (home indicator / nav bar).
 */
export function stageInsetVars(rotation: StageRotation): Record<`--stage-inset-${Side}`, string> {
  const screen = { top: LAYOUT.safeAreaTop, right: INSET_RIGHT, bottom: LAYOUT.safeAreaBottom, left: INSET_LEFT };
  const stage =
    rotation === 90
      ? { top: screen.right, right: screen.bottom, bottom: screen.left, left: screen.top }
      : screen;
  return {
    '--stage-inset-top': stage.top,
    '--stage-inset-right': stage.right,
    '--stage-inset-bottom': stage.bottom,
    '--stage-inset-left': stage.left,
  };
}

/**
 * Map a screen-space displacement (finger delta in `clientX/Y` units,
 * +y down) into the stage frame: the inverse of the stage's rotation.
 */
export function screenToStageDelta(dx: number, dy: number, rotation: StageRotation): { x: number; y: number } {
  if (rotation === 90) return { x: dy, y: -dx };
  return { x: dx, y: dy };
}

export const StageContext = createContext<StageContextValue>({ rotation: 0, container: null });

export function useStage(): StageContextValue {
  return useContext(StageContext);
}
