/**
 * Speaker volume card.
 *
 * Layout (inside the card body, single row):
 *   [🔊 mute toggle]  ●─────● slider
 *
 * The "speaker on/off" icon doubles as the mute toggle - same
 * visual language as the desktop conversation app, no duplicate
 * icons in the header.
 */
import { Box } from '@mui/material';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';
import VolumeOffRoundedIcon from '@mui/icons-material/VolumeOffRounded';

import ControlCard, { CardActionButton } from './ControlCard';
import ControlSlider from './ControlSlider';
import { TYPO } from '../../../styles/tokens';

interface SpeakerCardProps {
  /** Current value in [0, 100]. */
  volume: number;
  /** Fired on every drag tick of the slider. */
  onVolumeChange: (value: number) => void;
  /** Toggle between 0 and a sensible "unmute back to" value
   *  (handled upstream in `useAudioVolumes`). */
  onToggleMute: () => void;
  disabled?: boolean;
}

export default function SpeakerCard({
  volume,
  onVolumeChange,
  onToggleMute,
  disabled = false,
}: SpeakerCardProps) {
  const isOn = volume > 0;
  return (
    <ControlCard title="Speaker" disabled={disabled}>
      <CardActionButton
        ariaLabel={isOn ? 'Mute speaker' : 'Unmute speaker'}
        onClick={onToggleMute}
        active={isOn}
        disabled={disabled}
      >
        {isOn ? (
          <VolumeUpRoundedIcon sx={{ fontSize: TYPO.lg }} />
        ) : (
          <VolumeOffRoundedIcon sx={{ fontSize: TYPO.lg }} />
        )}
      </CardActionButton>
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          ml: 1,
          // Explicit flex-centring so the slider sits on the
          // row's vertical axis no matter what intrinsic height
          // MUI gives its native bounding box.
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <ControlSlider
          value={volume}
          onChange={onVolumeChange}
          disabled={disabled}
          ariaLabel="Speaker volume"
        />
      </Box>
    </ControlCard>
  );
}
