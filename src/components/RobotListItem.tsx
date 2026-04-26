import { Chip, ListItemButton, ListItemText, Stack } from '@mui/material';
import BluetoothIcon from '@mui/icons-material/Bluetooth';
import LinkIcon from '@mui/icons-material/Link';

import type { DiscoveredRobot, RobotNetworkMode } from '../types/robot';

interface RobotListItemProps {
  robot: DiscoveredRobot;
  onClick: () => void;
}

/**
 * One row in the discovery list.
 *
 * The primary label shows the robot name. The secondary line shows the
 * resolved IP (or the mode, e.g. `OFFLINE`, when no IP is available).
 * A right-side chip reinforces the network mode with a color hint.
 */
export default function RobotListItem({ robot, onClick }: RobotListItemProps) {
  const Icon = robot.source === 'manual' ? LinkIcon : BluetoothIcon;
  const secondary = robot.ip
    ? `${robot.ip}:${robot.port}`
    : robot.mode === 'offline'
      ? 'No IP (robot is offline)'
      : robot.mode === 'unknown'
        ? 'Awaiting network status…'
        : robot.mode.toUpperCase();

  const chip = modeChip(robot.mode, robot.source === 'manual');

  return (
    <ListItemButton
      onClick={onClick}
      sx={{
        borderRadius: 2,
        mb: 1,
        bgcolor: 'background.paper',
        border: theme => `1px solid ${theme.palette.divider}`,
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      <Stack direction="row" alignItems="center" spacing={2} sx={{ width: '100%' }}>
        <Icon color="primary" />
        <ListItemText
          primary={robot.name}
          secondary={secondary}
          primaryTypographyProps={{ fontWeight: 600 }}
          secondaryTypographyProps={{ fontFamily: 'monospace', fontSize: '0.75rem' }}
        />
        <Chip
          label={chip.label}
          color={chip.color}
          size="small"
          variant={chip.color === 'default' ? 'outlined' : 'filled'}
          sx={{ fontSize: '0.7rem' }}
        />
      </Stack>
    </ListItemButton>
  );
}

function modeChip(
  mode: RobotNetworkMode,
  isManual: boolean,
): { label: string; color: 'success' | 'warning' | 'error' | 'default' } {
  if (isManual) return { label: 'Manual', color: 'default' };
  switch (mode) {
    case 'connected':
      return { label: 'Connected', color: 'success' };
    case 'hotspot':
      return { label: 'Hotspot', color: 'warning' };
    case 'offline':
      return { label: 'Offline', color: 'error' };
    default:
      return { label: 'Reading…', color: 'default' };
  }
}
