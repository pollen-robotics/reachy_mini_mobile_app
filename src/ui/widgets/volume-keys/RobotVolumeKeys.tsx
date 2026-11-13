/**
 * Routes the phone's hardware volume buttons to the robot speaker while
 * `active` (the session is up and the robot is being controlled), and
 * flashes the resulting level. Must sit inside `<DaemonStateProvider>`.
 *
 * Android only (see `shared/volume-keys.ts`); renders nothing elsewhere
 * until a key is actually pressed.
 */
import { useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';
import VolumeOffRoundedIcon from '@mui/icons-material/VolumeOffRounded';

import { useDaemonState } from '@/features/daemon-state';
import { clampVolume, subscribeVolumeKeys } from '@/shared/volume-keys';

/** Percent per key press; holding the button repeats it. */
const STEP = 5;
const FLASH_MS = 1200;
/** Volume assumed when a key lands before the first fetch resolved. */
const FALLBACK_VOLUME = 50;

export function RobotVolumeKeys({ active }: { active: boolean }) {
  const { speakerVolume, setSpeakerVolume } = useDaemonState();
  const [flash, setFlash] = useState<number | null>(null);
  // Latest value on a ref: key presses can outpace React renders, and the
  // debounced setter only echoes back later.
  const volumeRef = useRef<number>(speakerVolume ?? FALLBACK_VOLUME);
  const setRef = useRef(setSpeakerVolume);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (speakerVolume !== null) volumeRef.current = speakerVolume;
  }, [speakerVolume]);
  useEffect(() => {
    setRef.current = setSpeakerVolume;
  }, [setSpeakerVolume]);

  useEffect(() => {
    if (!active) return;
    const off = subscribeVolumeKeys((direction) => {
      const next = clampVolume(volumeRef.current + direction * STEP);
      volumeRef.current = next;
      setRef.current(next);
      setFlash(next);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
    });
    return () => {
      off();
      window.clearTimeout(hideTimer.current);
      setFlash(null);
    };
  }, [active]);

  if (flash === null) return null;
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        position: 'fixed',
        top: 'calc(var(--inset-top, env(safe-area-inset-top, 0px)) + 16px)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1500,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 2,
        py: 1,
        borderRadius: 999,
        bgcolor: 'rgba(0,0,0,0.78)',
        color: '#fff',
        pointerEvents: 'none',
      }}
    >
      {flash === 0 ? <VolumeOffRoundedIcon fontSize="small" /> : <VolumeUpRoundedIcon fontSize="small" />}
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        Robot volume {flash}%
      </Typography>
    </Box>
  );
}
