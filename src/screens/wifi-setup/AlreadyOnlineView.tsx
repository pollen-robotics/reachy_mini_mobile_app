/**
 * Landing view when the robot was already on Wi-Fi when we connected
 * over BLE. The only action offered is "Forget Wi-Fi" - the user can
 * always re-enter the setup flow afterwards by re-pairing once the
 * robot reopens its hotspot. We deliberately do not surface a
 * separate "Change Wi-Fi" path: it would be a verbose alias for
 * "forget then add new" and offers no UX win.
 */
import { Button, Stack, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import WifiIcon from '@mui/icons-material/Wifi';

import { FONT_WEIGHT, TYPO } from '../../styles/tokens';

export function AlreadyOnlineView({
  ssid,
  ip,
  onForget,
}: {
  ssid: string | null;
  ip: string | null;
  onForget: () => void;
}) {
  const networkLine = ssid
    ? ip
      ? `Connected to "${ssid}" at ${ip}.`
      : `Connected to "${ssid}".`
    : ip
      ? `This robot is connected to a network at ${ip}.`
      : 'This robot is connected to a network.';
  return (
    <Stack alignItems="center" spacing={2.5} sx={{ width: '100%' }}>
      <WifiIcon sx={{ fontSize: 64, color: 'success.main' }} />
      <Typography
        sx={{
          fontSize: TYPO.lg,
          fontWeight: FONT_WEIGHT.semibold,
          textAlign: 'center',
        }}
      >
        Already on Wi-Fi
      </Typography>
      <Typography
        sx={{ fontSize: TYPO.sm, color: 'text.secondary', textAlign: 'center' }}
      >
        {networkLine} You can connect to it from the &ldquo;Distant&rdquo;
        section of the home screen. Tap below to drop this network and
        run a fresh setup (the robot will reopen its hotspot).
      </Typography>
      <Button
        startIcon={<DeleteOutlineIcon />}
        variant="contained"
        color="error"
        onClick={onForget}
      >
        Forget Wi-Fi
      </Button>
    </Stack>
  );
}
