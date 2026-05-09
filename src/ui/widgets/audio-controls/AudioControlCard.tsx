/**
 * Speaker / microphone volume card.
 *
 *   SPEAKER             <- label outside (uppercase tiny)
 *   ┌────────────────┐
 *   │ [🔊]  ●────●   │  <- icon-button left, slider right
 *   └────────────────┘
 *
 * Single component for both surfaces - the only difference between
 * the two is the icon set + ARIA labels, both folded into the
 * `kind` prop. Guarantees the speaker and microphone cards have
 * identical chrome AND identical dimensions: same fixed icon size,
 * same minHeight, same MUI slider, same border / padding.
 *
 * Pure presentational. Volume + mute toggle handlers come from the
 * `useAudioVolumes` hook one level up.
 */
import { IconButton, Slider, Stack, Typography, alpha } from '@mui/material';
import MicRoundedIcon from '@mui/icons-material/MicRounded';
import MicOffRoundedIcon from '@mui/icons-material/MicOffRounded';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';
import VolumeOffRoundedIcon from '@mui/icons-material/VolumeOffRounded';
import type { ReactNode } from 'react';

import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

export type AudioKind = 'speaker' | 'microphone';

interface AudioControlCardProps {
  kind: AudioKind;
  /** Current value in [0, 100]. */
  value: number;
  /** Fired on every drag tick of the slider. Parent debounces the
   *  network round-trip. */
  onChange: (value: number) => void;
  /** Toggle between 0 and a sensible "unmute back to" value
   *  (handled upstream in `useAudioVolumes`). */
  onToggleMute: () => void;
  disabled?: boolean;
}

/** Icon button height. Drives the row's `minHeight` so both card
 *  variants render at the exact same size regardless of the
 *  slider's intrinsic MUI bounding box. */
const ICON_BTN_SIZE = 28;
const ROW_MIN_HEIGHT = 44;

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

const LABELS: Record<
  AudioKind,
  { title: string; muteAria: (isOn: boolean) => string; sliderAria: string }
> = {
  speaker: {
    title: 'Speaker',
    muteAria: (isOn) => (isOn ? 'Mute speaker' : 'Unmute speaker'),
    sliderAria: 'Speaker volume',
  },
  microphone: {
    title: 'Microphone',
    muteAria: (isOn) => (isOn ? 'Mute microphone' : 'Unmute microphone'),
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
  const { title, muteAria, sliderAria } = LABELS[kind];
  const icon = ICONS[kind][isOn ? 'on' : 'off'];

  return (
    <Stack
      spacing={0.5}
      sx={(theme) => ({
        opacity: disabled ? 0.5 : 1,
        transition: theme.transitions.create('opacity', {
          duration: theme.transitions.duration.short,
        }),
        minWidth: 0,
        width: '100%',
      })}
    >
      {/* Label OUTSIDE the card - uppercase tiny, same as the
          desktop conversation app. */}
      <Typography
        sx={{
          fontSize: TYPO.tiny,
          fontWeight: FONT_WEIGHT.semibold,
          color: 'text.secondary',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          lineHeight: 1.1,
          ml: 0.25,
        }}
        noWrap
      >
        {title}
      </Typography>

      {/* The card itself. Single flex row: icon-button on the left,
          slider taking the rest. `minHeight` pins both card
          variants to the same physical size regardless of the
          slider's intrinsic MUI bounding-box height. */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={(theme) => ({
          minWidth: 0,
          minHeight: ROW_MIN_HEIGHT,
          px: 1.25,
          py: 0.5,
          borderRadius: '12px',
          bgcolor: theme.palette.background.paper,
          border: `1px solid ${
            theme.palette.mode === 'dark'
              ? 'rgba(255,255,255,0.10)'
              : 'rgba(0,0,0,0.06)'
          }`,
        })}
      >
        <IconButton
          aria-label={muteAria(isOn)}
          onClick={onToggleMute}
          disabled={disabled}
          size="small"
          sx={(theme) => ({
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
          sx={(theme) => ({
            color: theme.palette.primary.main,
            flex: 1,
            '& .MuiSlider-thumb': {
              width: 12,
              height: 12,
              backgroundColor: theme.palette.primary.main,
              border: `1.5px solid ${theme.palette.background.paper}`,
              boxShadow: 'none',
              '&:hover, &.Mui-focusVisible, &.Mui-active': {
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
      </Stack>
    </Stack>
  );
}
