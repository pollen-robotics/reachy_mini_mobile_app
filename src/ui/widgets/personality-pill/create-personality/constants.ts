/**
 * Shared constants + styles for the "create a personality" surface.
 *
 * Extracted from `CreatePersonalityModal` so the modal and its split-out
 * pieces (`Hero`, `Fields`, `Actions`) share one source of truth for field
 * limits, button looks, and the floating-label backing fix.
 */
import { alpha, type Theme } from '@mui/material/styles';

import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

/** Input clamps (mirror the data layer / manual form). */
export const NAME_MAX = 24;
export const TAGLINE_MAX = 60;
export const VIBE_MAX = 240;

/** Shared look for the primary CTA (outlined primary, comfortable tap
 *  target). Reused so every action-plate button - the hero's "Bring it to
 *  life", "Create & use", the edit row's Save/Delete - stays byte-identical. */
export const ctaSx = {
  textTransform: 'none',
  fontSize: TYPO.md,
  fontWeight: FONT_WEIGHT.semibold,
  py: 1.25,
  borderWidth: 1.5,
  '&:hover': { borderWidth: 1.5 },
  borderRadius: `${RADIUS.md}px`,
} as const;

/**
 * "Surprise me" idea button, sitting in the vibe card's footer.
 *
 * It used to be a label-less die tucked inside the input as an end
 * adornment, which made the one affordance that unblocks an empty screen
 * the least legible thing on it (and gave no hint that tapping it
 * REPLACES whatever you typed). Now it's a compact labelled text button:
 * borderless and primary-tinted so it stays subordinate to the plate's CTA,
 * but readable without a hover.
 */
export const ideaBtnSx = {
  textTransform: 'none',
  fontSize: TYPO.sm,
  fontWeight: FONT_WEIGHT.semibold,
  color: 'primary.main',
  px: 0.75,
  py: 0.25,
  minWidth: 0,
  borderRadius: `${RADIUS.sm}px`,
  '&:hover': {
    bgcolor: (t: Theme) => alpha(t.palette.primary.main, 0.08),
  },
} as const;

/**
 * When the floating label shrinks onto the outline it must sit over a solid
 * fill, otherwise the border draws straight through the text. The form sits
 * on `background.default`, so a matching backing is seamless when the notch
 * is open (and a safety net if it ever fails to open, notably on multiline).
 */
export const shrinkLabelSlotProps = {
  inputLabel: {
    sx: {
      '&.MuiInputLabel-shrink': {
        bgcolor: 'background.default',
        px: 0.5,
      },
    },
  },
} as const;
