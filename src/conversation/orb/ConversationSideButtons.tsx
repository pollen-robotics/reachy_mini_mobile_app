/**
 * Mute / Stop side buttons that flank the orb during a live session.
 *
 * Each button is rendered independently (`<MuteSideButton>`,
 * `<StopSideButton>`) so the parent can place them on either side of
 * the orb with the layout it wants. Buttons collapse to width 0
 * outside live states so the idle orb stays optically centered
 * without empty placeholder slots.
 */
import { Box, IconButton } from '@mui/material';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import StopIcon from '@mui/icons-material/Stop';

export interface MuteSideButtonProps {
  live: boolean;
  micMuted: boolean;
  onToggleMute: () => void;
}

export function MuteSideButton({
  live,
  micMuted,
  onToggleMute,
}: MuteSideButtonProps) {
  return (
    <SideSlot live={live}>
      <IconButton
        aria-label={micMuted ? 'Unmute' : 'Mute'}
        title={micMuted ? 'Unmute' : 'Mute'}
        onClick={onToggleMute}
        sx={(theme) => ({
          width: 52,
          height: 52,
          border: `1px solid ${
            micMuted ? theme.palette.error.main : theme.palette.divider
          }`,
          color: micMuted
            ? theme.palette.error.contrastText
            : theme.palette.text.primary,
          bgcolor: micMuted
            ? theme.palette.error.main
            : theme.palette.action.hover,
          '&:hover': {
            bgcolor: micMuted
              ? theme.palette.error.dark
              : theme.palette.action.selected,
          },
        })}
      >
        {micMuted ? <MicOffIcon /> : <MicIcon />}
      </IconButton>
    </SideSlot>
  );
}

export interface StopSideButtonProps {
  live: boolean;
  onStop: () => void;
}

export function StopSideButton({ live, onStop }: StopSideButtonProps) {
  return (
    <SideSlot live={live}>
      <IconButton
        aria-label="End conversation"
        title="End conversation"
        onClick={onStop}
        sx={(theme) => ({
          width: 52,
          height: 52,
          border: `1px solid ${theme.palette.divider}`,
          color: theme.palette.text.primary,
          bgcolor: theme.palette.action.hover,
          '&:hover': {
            bgcolor: theme.palette.error.main,
            color: theme.palette.error.contrastText,
            borderColor: theme.palette.error.main,
          },
        })}
      >
        <StopIcon />
      </IconButton>
    </SideSlot>
  );
}

function SideSlot({
  live,
  children,
}: {
  live: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box
      sx={{
        flex: 'none',
        width: live ? 52 : 0,
        opacity: live ? 1 : 0,
        transform: live ? 'scale(1)' : 'scale(0.55)',
        pointerEvents: live ? 'auto' : 'none',
        overflow: 'hidden',
        transition:
          'width 0.25s ease, opacity 0.25s ease, transform 0.25s ease',
      }}
    >
      {children}
    </Box>
  );
}
