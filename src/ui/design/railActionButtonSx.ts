/**
 * Shared style for the small outlined action button pinned to the
 * right of a rail title - the apps tab's "See all" (`AppRail`) and the
 * personality store's "+ New" (`PersonalityStore`). Factored out so the
 * two browse surfaces stay pixel-aligned (same size, padding, and
 * border radius) instead of drifting in two separate sx blocks.
 *
 * Outlined primary, sentence-case, with the trailing glyph tucked in
 * close. Use on a MUI `<Button variant="outlined" color="primary">`.
 */
import type { SxProps, Theme } from '@mui/material';

import { FONT_WEIGHT, RADIUS, TYPO } from './tokens';

export const railActionButtonSx: SxProps<Theme> = {
  flexShrink: 0,
  fontSize: TYPO.sm,
  fontWeight: FONT_WEIGHT.semibold,
  textTransform: 'none',
  minWidth: 0,
  lineHeight: 1.4,
  px: 1.5,
  py: 0.5,
  borderRadius: `${RADIUS.sm}px`,
  // Pull the trailing glyph in closer to the label - MUI's default
  // endIcon margin (8px) floats it away and breaks single-glance
  // reading.
  '& .MuiButton-endIcon': { ml: 0.25 },
};
