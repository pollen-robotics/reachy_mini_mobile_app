/**
 * Compact orange slider used inside the speaker / microphone
 * cards. Visual mirror of the desktop app's audio sliders so the
 * two surfaces look the same.
 *
 * Pure presentational: the parent owns the value + change handler.
 */
import { Slider, alpha } from '@mui/material';

interface ControlSliderProps {
  value: number;
  /** Fired on every drag tick. The parent is expected to debounce
   *  the network round-trip (the slider itself does no debouncing
   *  - it stays purely presentational). */
  onChange: (value: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export default function ControlSlider({
  value,
  onChange,
  disabled = false,
  ariaLabel,
}: ControlSliderProps) {
  return (
    <Slider
      value={value}
      onChange={(_e, val) => onChange(val as number)}
      disabled={disabled}
      size="small"
      aria-label={ariaLabel}
      sx={theme => ({
        color: theme.palette.primary.main,
        // The bounding-box height MUST match the sibling icon button
        // (28 px) so the row's `alignItems: center` produces a
        // visual centre that's identical across the two children.
        // Using the default `padding: '10px 0'` left the slider's
        // bounding box at 23 px, so even though the rail and the
        // button centre lined up to the pixel, the *whitespace*
        // around each child read as asymmetric and the row felt
        // off-balance. Explicit height + zero vertical padding
        // pins the rail to the row centre and the child heights
        // match cleanly.
        height: 28,
        padding: 0,
        // The rail / track / thumb live inside `& span` shadow
        // children whose default vertical alignment is the
        // bounding-box centre, so no further offset is needed -
        // they sit at row y = 14 automatically.
        '& .MuiSlider-thumb': {
          width: 12,
          height: 12,
          backgroundColor: theme.palette.primary.main,
          border: `1.5px solid ${theme.palette.background.paper}`,
          boxShadow: 'none',
          '&:hover': {
            boxShadow: `0 0 0 6px ${alpha(
              theme.palette.primary.main,
              0.12,
            )}`,
          },
          '&.Mui-focusVisible': {
            boxShadow: `0 0 0 6px ${alpha(
              theme.palette.primary.main,
              0.16,
            )}`,
          },
          '&.Mui-active': {
            boxShadow: `0 0 0 6px ${alpha(
              theme.palette.primary.main,
              0.16,
            )}`,
          },
        },
        '& .MuiSlider-track': {
          backgroundColor: theme.palette.primary.main,
          border: 'none',
          height: 1.5,
        },
        '& .MuiSlider-rail': {
          backgroundColor:
            theme.palette.mode === 'dark'
              ? 'rgba(255,255,255,0.12)'
              : 'rgba(0,0,0,0.12)',
          height: 1.5,
          opacity: 1,
        },
      })}
    />
  );
}
