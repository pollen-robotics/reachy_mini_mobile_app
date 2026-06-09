/**
 * OutlinedSwitch - a Switch restyled to match the app's "outlined"
 * language (outlined buttons, hairline cards, bordered chips).
 *
 * Instead of MUI's default filled track, the track is a transparent
 * pill with a constant 1.5px border and the thumb is a small dot:
 *   - OFF: divider-coloured border + `text.secondary` thumb
 *   - ON:  primary border + soft primary fill + primary thumb
 *
 * The border width never changes between states (only its colour),
 * so toggling never resizes the control. Kept as a dedicated styled
 * component (rather than inline `sx` at every call site or a global
 * `MuiSwitch` theme override) so the outlined treatment is opt-in and
 * reusable wherever a toggle is needed.
 */
import { Switch, alpha, styled } from '@mui/material';

const TRACK_W = 42;
const TRACK_H = 24;
const THUMB = 14;
const INSET = 5;

export const OutlinedSwitch = styled(Switch)(({ theme }) => ({
  width: TRACK_W,
  height: TRACK_H,
  padding: 0,
  '& .MuiSwitch-switchBase': {
    padding: 0,
    margin: INSET,
    transitionDuration: '200ms',
    // Thumb colour flows from `color` via the thumb's `currentColor`.
    color: theme.palette.text.secondary,
    '&.Mui-checked': {
      transform: `translateX(${TRACK_W - THUMB - INSET * 2}px)`,
      color: theme.palette.primary.main,
      '& + .MuiSwitch-track': {
        borderColor: theme.palette.primary.main,
        backgroundColor: alpha(theme.palette.primary.main, 0.12),
        opacity: 1,
      },
    },
    '&.Mui-disabled + .MuiSwitch-track': { opacity: 0.4 },
    '&.Mui-disabled .MuiSwitch-thumb': { opacity: 0.4 },
  },
  '& .MuiSwitch-thumb': {
    width: THUMB,
    height: THUMB,
    boxShadow: 'none',
    backgroundColor: 'currentColor',
  },
  '& .MuiSwitch-track': {
    borderRadius: TRACK_H / 2,
    border: `1.5px solid ${theme.palette.divider}`,
    backgroundColor: 'transparent',
    opacity: 1,
    boxSizing: 'border-box',
    transition: theme.transitions.create(
      ['background-color', 'border-color'],
      { duration: 200 },
    ),
  },
}));
