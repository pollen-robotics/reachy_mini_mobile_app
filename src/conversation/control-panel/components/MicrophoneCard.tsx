/**
 * Microphone volume card.
 *
 * Layout (single row, identical chrome to `SpeakerCard`):
 *   [🎤 mute toggle]  ●─────● slider
 *
 * The "mic on/off" icon doubles as the mute toggle - same
 * visual language as the desktop conversation app.
 */
import { Box } from '@mui/material';
import MicRoundedIcon from '@mui/icons-material/MicRounded';
import MicOffRoundedIcon from '@mui/icons-material/MicOffRounded';

import ControlCard, { CardActionButton } from './ControlCard';
import ControlSlider from './ControlSlider';
import { TYPO } from '../../../styles/tokens';

interface MicrophoneCardProps {
  /** Current value in [0, 100]. */
  volume: number;
  /** Fired on every drag tick of the slider. */
  onVolumeChange: (value: number) => void;
  /** Toggle between 0 and a sensible "unmute back to" value. */
  onToggleMute: () => void;
  disabled?: boolean;
}

export default function MicrophoneCard({
  volume,
  onVolumeChange,
  onToggleMute,
  disabled = false,
}: MicrophoneCardProps) {
  const isOn = volume > 0;
  return (
    <ControlCard title="Microphone" disabled={disabled}>
      <CardActionButton
        ariaLabel={isOn ? 'Mute microphone' : 'Unmute microphone'}
        onClick={onToggleMute}
        active={isOn}
        disabled={disabled}
      >
        {isOn ? (
          <MicRoundedIcon sx={{ fontSize: TYPO.lg }} />
        ) : (
          <MicOffRoundedIcon sx={{ fontSize: TYPO.lg }} />
        )}
      </CardActionButton>
      <Box sx={{ flex: 1, minWidth: 0, ml: 1 }}>
        <ControlSlider
          value={volume}
          onChange={onVolumeChange}
          disabled={disabled}
          ariaLabel="Microphone volume"
        />
      </Box>
    </ControlCard>
  );
}
