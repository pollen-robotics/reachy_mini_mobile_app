/**
 * Shared "glass" surface for controls floating over the live camera
 * feed: dark translucent fill + blur + hairline light border, so white
 * glyphs stay legible over any imagery (same recipe as the joysticks).
 */
export const glassSurfaceSx = {
  bgcolor: 'rgba(0, 0, 0, 0.38)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  border: '1px solid rgba(255, 255, 255, 0.22)',
  color: '#fff',
};

/** 44 px round glass icon button (Apple's minimum tap target). */
export const glassIconButtonSx = {
  ...glassSurfaceSx,
  width: 44,
  height: 44,
  '&:hover': { bgcolor: 'rgba(0, 0, 0, 0.5)' },
  '&.Mui-disabled': { color: 'rgba(255, 255, 255, 0.4)' },
};

/** Wheels joystick accent, distinct from the (primary orange) head stick. */
export const WHEELS_COLOR = '#3b82f6';
