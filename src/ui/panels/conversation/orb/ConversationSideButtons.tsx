/**
 * Mute / Stop side buttons that flank the orb during a live session.
 *
 * Each button is rendered independently (`<MuteSideButton>`,
 * `<StopSideButton>`) so the parent can place them on either side of
 * the orb with the layout it wants. Buttons collapse to width 0
 * outside live states so the idle orb stays optically centered
 * without empty placeholder slots.
 *
 * Design language: white pill buttons with primary-orange OUTLINED
 * icons - matches the rest of the conversation surface (cards =
 * white, primary = orange call-to-action). Negative actions
 * (muted mic, stop hover) flip to error red so destructive intent
 * still reads at a glance.
 */
import { Box, IconButton } from '@mui/material';
import MicNoneOutlinedIcon from '@mui/icons-material/MicNoneOutlined';
import MicOffOutlinedIcon from '@mui/icons-material/MicOffOutlined';
import StopOutlinedIcon from '@mui/icons-material/StopOutlined';

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
          // White pill on the conversation surface; border + icon
          // colour signal the state. Primary orange when active,
          // error red when muted (so the "off" state pops at a
          // glance even with the same white background).
          bgcolor: theme.palette.background.paper,
          border: `1px solid ${
            micMuted ? theme.palette.error.main : theme.palette.divider
          }`,
          color: micMuted
            ? theme.palette.error.main
            : theme.palette.primary.main,
          '&:hover': {
            bgcolor: theme.palette.background.paper,
            borderColor: micMuted
              ? theme.palette.error.main
              : theme.palette.primary.main,
          },
        })}
      >
        {micMuted ? <MicOffOutlinedIcon /> : <MicNoneOutlinedIcon />}
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
          bgcolor: theme.palette.background.paper,
          border: `1px solid ${theme.palette.divider}`,
          color: theme.palette.primary.main,
          '&:hover': {
            // Hover flips to destructive red so the "this ends
            // the conversation" intent reads clearly the moment
            // the user mouses over.
            bgcolor: theme.palette.error.main,
            color: theme.palette.error.contrastText,
            borderColor: theme.palette.error.main,
          },
        })}
      >
        <StopOutlinedIcon />
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
