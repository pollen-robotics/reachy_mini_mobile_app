/**
 * Round glass audio toggle for the telepresence overlay.
 *
 *   tap         → mute / unmute the stream (phone mic → robot, or
 *                 robot mic → phone)
 *   long-press  → pop a vertical volume slider underneath, bound to
 *                 the matching FAR-END daemon volume (robot speaker for
 *                 the mic button, robot mic gain for the speaker button)
 */
import { useRef, useState } from 'react';
import { Box, CircularProgress, IconButton, Popover, Slider, Typography } from '@mui/material';

import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

import { glassIconButtonSx, glassSurfaceSx } from './glass';

const LONG_PRESS_MS = 450;

interface SoundButtonProps {
  on: boolean;
  onToggle: () => void;
  iconOn: React.ReactNode;
  iconOff: React.ReactNode;
  ariaLabel: string;
  volume: number | null;
  onVolumeChange: (value: number) => void;
  volumeLabel: string;
  pending?: boolean;
  disabled?: boolean;
}

export default function SoundButton({
  on,
  onToggle,
  iconOn,
  iconOff,
  ariaLabel,
  volume,
  onVolumeChange,
  volumeLabel,
  pending = false,
  disabled = false,
}: SoundButtonProps) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);
  const [open, setOpen] = useState(false);

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  return (
    <>
      <IconButton
        ref={anchorRef}
        aria-label={ariaLabel}
        disabled={disabled}
        onPointerDown={() => {
          longPressedRef.current = false;
          clearTimer();
          timerRef.current = setTimeout(() => {
            longPressedRef.current = true;
            setOpen(true);
          }, LONG_PRESS_MS);
        }}
        onPointerUp={clearTimer}
        onPointerLeave={clearTimer}
        onPointerCancel={clearTimer}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          // The click that ends a long-press must not also toggle.
          if (longPressedRef.current) return;
          onToggle();
        }}
        sx={[
          glassIconButtonSx,
          !on && { bgcolor: 'rgba(239, 68, 68, 0.55)', '&:hover': { bgcolor: 'rgba(239, 68, 68, 0.7)' } },
          { WebkitTouchCallout: 'none', userSelect: 'none' },
        ]}
      >
        {pending ? <CircularProgress size={18} sx={{ color: '#fff' }} /> : on ? iconOn : iconOff}
      </IconButton>
      <Popover
        open={open}
        anchorEl={anchorRef.current}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{
          paper: {
            sx: {
              ...glassSurfaceSx,
              mt: 1,
              borderRadius: 999,
              px: 1,
              py: 2,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1.5,
              overflow: 'visible',
            },
          },
        }}
      >
        <Typography sx={{ fontSize: TYPO.micro, fontWeight: FONT_WEIGHT.bold, color: '#fff' }}>
          {volume ?? '–'}
        </Typography>
        <Box sx={{ height: 150 }}>
          <Slider
            orientation="vertical"
            aria-label={volumeLabel}
            value={volume ?? 50}
            min={0}
            max={100}
            onChange={(_, v) => onVolumeChange(v as number)}
            sx={{ color: '#fff' }}
          />
        </Box>
        <Typography
          sx={{
            fontSize: TYPO.nano,
            fontWeight: FONT_WEIGHT.bold,
            letterSpacing: '0.8px',
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.75)',
            writingMode: 'vertical-rl',
            transform: 'rotate(180deg)',
          }}
        >
          {volumeLabel}
        </Typography>
      </Popover>
    </>
  );
}
