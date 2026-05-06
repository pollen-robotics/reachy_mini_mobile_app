/**
 * Base card used by `SpeakerCard` and `MicrophoneCard`.
 *
 * Mirrors the desktop conversation app's audio control layout:
 *
 *   SPEAKER                    ← label outside the card border
 *   ┌─────────────────────┐
 *   │  [🔊]   ●─────●     │   ← controls row, padded
 *   └─────────────────────┘
 *
 *   MICROPHONE
 *   ┌─────────────────────┐
 *   │  [🎤]   ●─────●     │
 *   │~~~~~~~~~~~~~~~~~~~~~│   ← optional visualizer slot, FLUSH
 *   └─────────────────────┘    with the card edges (no padding)
 *
 * Owns ONLY the chrome (label + border + padding) and the
 * visualizer slot wiring. The concrete card composes this with
 * its own controls (button + slider) in `children`.
 *
 * The visualizer slot, when provided, sits at the bottom of the
 * card and goes EDGE-TO-EDGE so the waveform looks part of the
 * card's surface rather than a floating element with margins -
 * matching the desktop's `AudioLevelBars` placement.
 */
import { Box, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import { FONT_WEIGHT, TYPO } from '../../../styles/tokens';

interface ControlCardProps {
  /** Label rendered ABOVE the card border, in uppercase tiny font.
   *  Mirrors the desktop's "SPEAKER" / "MICROPHONE" label row. */
  title: string;
  /** Card body - typically a row with the mute toggle + slider. */
  children: ReactNode;
  /** Optional flush-bottom slot. Used by the microphone card to
   *  host the audio level waveform; the slot has zero horizontal
   *  padding so the waveform reads as part of the card surface
   *  rather than a floating element. */
  visualizer?: ReactNode;
  /** Greys out the whole card (chrome + label + body + visualizer)
   *  so the disabled state is visually obvious without us having
   *  to thread a disabled flag through every child component. */
  disabled?: boolean;
}

export default function ControlCard({
  title,
  children,
  visualizer,
  disabled = false,
}: ControlCardProps) {
  return (
    <Stack
      spacing={0.5}
      sx={{
        opacity: disabled ? 0.5 : 1,
        transition: theme =>
          theme.transitions.create('opacity', {
            duration: theme.transitions.duration.short,
          }),
        minWidth: 0,
        width: '100%',
      }}
    >
      {/* Label OUTSIDE the card border. Tiny, uppercase, muted -
          matches the desktop's "SPEAKER" / "MICROPHONE" label. */}
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

      {/* The card itself. `overflow: hidden` matters so the flush
          visualizer respects the rounded corners. */}
      <Box
        sx={theme => ({
          borderRadius: '12px',
          // White cards on the grey canvas - same convention as
          // the robot cards in `ScanScreen` and the app cards
          // in `AppCard`. The cards are the only WHITE
          // surfaces in the screen, so they read as the
          // "interesting" content the user can act on.
          bgcolor: theme.palette.background.paper,
          border: `1px solid ${
            theme.palette.mode === 'dark'
              ? 'rgba(255,255,255,0.10)'
              : 'rgba(0,0,0,0.06)'
          }`,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
        })}
      >
        {/* Body: padded controls row.
         *
         *   ┌─────────────────────────┐
         *   │       py = 1            │
         *   │  [icon 28]  ●─slider──● │  ← row centre matches both
         *   │       py = 1            │     children's centres
         *   └─────────────────────────┘
         *
         * Both children are 28 px tall (button is fixed 28; slider
         * was bumped to 28 in `ControlSlider`) so the row height is
         * deterministic at 28 + 2×8 = 44 px, with strictly equal
         * vertical breathing top and bottom. */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            px: 1.25,
            py: 1,
            minWidth: 0,
          }}
        >
          {children}
        </Box>

        {/* Optional visualizer, flush with the card edges. */}
        {visualizer ? (
          <Box sx={{ width: '100%', flexShrink: 0 }}>{visualizer}</Box>
        ) : null}
      </Box>
    </Stack>
  );
}

/**
 * Mute / unmute icon button used inline next to the slider in
 * each concrete card. Hit target is 28×28 (iOS comfortable);
 * colour follows the active state (subdued when on, more subdued
 * when off, primary on hover).
 */
export function CardActionButton({
  ariaLabel,
  onClick,
  active,
  disabled = false,
  children,
}: {
  ariaLabel: string;
  onClick: () => void;
  /** Whether the underlying control is "on" (volume > 0). */
  active: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Box
      component="button"
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      sx={theme => ({
        all: 'unset',
        cursor: disabled ? 'default' : 'pointer',
        width: 28,
        height: 28,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '8px',
        color: active
          ? theme.palette.mode === 'dark'
            ? 'rgba(255,255,255,0.7)'
            : 'rgba(0,0,0,0.65)'
          : theme.palette.mode === 'dark'
            ? 'rgba(255,255,255,0.35)'
            : 'rgba(0,0,0,0.35)',
        transition: theme.transitions.create(['color', 'background-color'], {
          duration: theme.transitions.duration.shortest,
        }),
        '&:hover': {
          color: active
            ? theme.palette.primary.main
            : theme.palette.mode === 'dark'
              ? 'rgba(255,255,255,0.55)'
              : 'rgba(0,0,0,0.55)',
        },
        '&:focus-visible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
      })}
    >
      {children}
    </Box>
  );
}
