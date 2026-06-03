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
 *  target). Reused so "Create & use" and the edit row's "Save" stay
 *  byte-identical. */
export const ctaSx = {
  textTransform: 'none',
  fontSize: TYPO.md,
  fontWeight: FONT_WEIGHT.semibold,
  py: 1.25,
  borderWidth: 1.5,
  '&:hover': { borderWidth: 1.5 },
  borderRadius: `${RADIUS.md}px`,
} as const;

/** Shared look for the generation buttons (Generate / Randomize), both
 *  outlined primary so they read as a matched pair. */
export const genBtnSx = {
  textTransform: 'none',
  fontSize: TYPO.sm,
  fontWeight: FONT_WEIGHT.semibold,
  borderRadius: `${RADIUS.md}px`,
  borderWidth: 1.5,
  '&:hover': { borderWidth: 1.5 },
} as const;

/** Label-less "Randomize" die that lives INSIDE the vibe input (end
 *  adornment): borderless, primary-tinted. */
export const diceBtnSx = {
  color: 'primary.main',
  p: 0.75,
  '&:hover': {
    bgcolor: (t: Theme) => alpha(t.palette.primary.main, 0.08),
  },
} as const;

/** Playful status lines cycled on the Generate button while the model
 *  authors the persona. Order roughly matches what the single LLM call
 *  produces (name -> voice -> prompt). */
export const GEN_STEPS = [
  'Imagining a character…',
  'Choosing a name…',
  'Finding the right voice…',
  'Writing its personality…',
] as const;

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
