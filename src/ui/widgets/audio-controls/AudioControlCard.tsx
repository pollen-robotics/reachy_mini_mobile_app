/**
 * Speaker / microphone volume control row.
 *
 *   [🔊]  ●────────●   <- mute icon-button (left), slider (right)
 *
 * Single component for both surfaces - the only difference between
 * the two is the icon set + ARIA labels, both folded into the
 * `kind` prop. Guarantees the speaker and microphone rows have
 * identical dimensions: same fixed icon size, same minHeight,
 * same MUI slider styling.
 *
 * No internal card chrome: the host surface (e.g. the audio strip
 * under the orb in `<ConversationPanel>`) provides whatever frame
 * it needs around the row; painting a border + paper bg here would
 * stack two cards, one inside the other. The component is a pure
 * layout row (icon + slider), and the parent owns the surface.
 *
 * Pure presentational. Volume + mute toggle handlers come from
 * the shared `useDaemonState()` context (mounted in
 * `RobotSessionScreen`), threaded through whichever surface
 * mounts the rows.
 */
import { IconButton, Slider, Stack, alpha } from '@mui/material';
import MicRoundedIcon from '@mui/icons-material/MicRounded';
import MicOffRoundedIcon from '@mui/icons-material/MicOffRounded';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';
import VolumeOffRoundedIcon from '@mui/icons-material/VolumeOffRounded';
import type { ReactNode } from 'react';

import { TYPO } from '@/ui/design/tokens';

export type AudioKind = 'speaker' | 'microphone';

interface AudioControlCardProps {
  kind: AudioKind;
  /** Current value in [0, 100]. */
  value: number;
  /** Fired on every drag tick of the slider. Parent debounces the
   *  network round-trip. */
  onChange: (value: number) => void;
  /** Toggle between 0 and a sensible "unmute back to" value
   *  (handled upstream in `useDaemonState`). */
  onToggleMute: () => void;
  disabled?: boolean;
}

/** Icon button height. Drives the row's `minHeight` so both card
 *  variants render at the exact same size regardless of the
 *  slider's intrinsic MUI bounding box. */
const ICON_BTN_SIZE = 28;
const ROW_MIN_HEIGHT = 24;

const ICONS: Record<AudioKind, { on: ReactNode; off: ReactNode }> = {
  speaker: {
    on: <VolumeUpRoundedIcon sx={{ fontSize: TYPO.lg }} />,
    off: <VolumeOffRoundedIcon sx={{ fontSize: TYPO.lg }} />,
  },
  microphone: {
    on: <MicRoundedIcon sx={{ fontSize: TYPO.lg }} />,
    off: <MicOffRoundedIcon sx={{ fontSize: TYPO.lg }} />,
  },
};

const LABELS: Record<AudioKind, { muteAria: (isOn: boolean) => string; sliderAria: string }> = {
  speaker: {
    muteAria: isOn => (isOn ? 'Mute speaker' : 'Unmute speaker'),
    sliderAria: 'Speaker volume',
  },
  microphone: {
    muteAria: isOn => (isOn ? 'Mute microphone' : 'Unmute microphone'),
    sliderAria: 'Microphone volume',
  },
};

export default function AudioControlCard({
  kind,
  value,
  onChange,
  onToggleMute,
  disabled = false,
}: AudioControlCardProps) {
  const isOn = value > 0;
  const { muteAria, sliderAria } = LABELS[kind];
  const icon = ICONS[kind][isOn ? 'on' : 'off'];

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={[
        {
          alignItems: 'center',
        },
        theme => ({
          opacity: disabled ? 0.5 : 1,
          transition: theme.transitions.create('opacity', {
            duration: theme.transitions.duration.short,
          }),
          minWidth: 0,
          width: '100%',
          minHeight: ROW_MIN_HEIGHT,
          // No own background: the host (`<RobotPanel>`) already
          // paints `background.paper` on the surrounding card, so
          // a second paper layer here would either be redundant
          // (no visible change) or, with `opacity: 0.5` on the
          // disabled state, create a subtle muddied tint where
          // both faded papers blend over the parent. Inheriting
          // the panel's surface keeps the row clean in both
          // light + dark modes. If you ever drop this widget
          // outside a `<RobotPanel>`, wrap it in a paper surface
          // at the call site.
          // Extra right padding so the slider's thumb has room to
          // breathe before the card edge. The mute icon button on
          // the left already absorbs its own visual gutter via the
          // IconButton's hit area, so we only pad the right side.
          pr: 2,
        }),
      ]}
    >
      <IconButton
        aria-label={muteAria(isOn)}
        onClick={onToggleMute}
        disabled={disabled}
        size="small"
        sx={theme => ({
          width: ICON_BTN_SIZE,
          height: ICON_BTN_SIZE,
          flexShrink: 0,
          color: theme.palette.text.secondary,
          '&:hover': {
            color: theme.palette.primary.main,
            backgroundColor: 'transparent',
          },
        })}
      >
        {icon}
      </IconButton>
      <Slider
        value={value}
        onChange={(_, val) => onChange(val as number)}
        disabled={disabled}
        size="small"
        aria-label={sliderAria}
        sx={theme => ({
          color: theme.palette.primary.main,
          flex: 1,
          '& .MuiSlider-thumb': {
            width: 12,
            height: 12,
            backgroundColor: theme.palette.primary.main,
            border: `1.5px solid ${theme.palette.background.paper}`,
            boxShadow: 'none',
            '&:hover, &.Mui-focusVisible, &.Mui-active': {
              boxShadow: `0 0 0 6px ${alpha(theme.palette.primary.main, 0.16)}`,
            },
          },
          '& .MuiSlider-track': {
            backgroundColor: theme.palette.primary.main,
            border: 'none',
            height: 1.5,
          },
          '& .MuiSlider-rail': {
            backgroundColor:
              theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)',
            height: 1.5,
            opacity: 1,
          },
        })}
      />
    </Stack>
  );
}
