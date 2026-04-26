import { Alert, AlertTitle, Stack, Typography } from '@mui/material';

interface NetworkMismatchPanelProps {
  robotIp: string;
  phoneIps: ReadonlyArray<string>;
}

/**
 * Displayed when the robot IP read over BLE is not on the same /24 as any
 * of the phone's IPs. Instead of trying to open WiFi settings (too many
 * platform-specific edge cases for a POC), we show a calm, actionable
 * explanation.
 */
export default function NetworkMismatchPanel({
  robotIp,
  phoneIps,
}: NetworkMismatchPanelProps) {
  return (
    <Alert severity="warning" variant="outlined">
      <AlertTitle>Different network</AlertTitle>
      <Stack spacing={1}>
        <Typography variant="body2">
          Your robot is on <strong>{robotIp}</strong>, but your phone is on{' '}
          <strong>{phoneIps.length === 0 ? 'no WiFi network' : phoneIps.join(', ')}</strong>.
        </Typography>
        <Typography variant="body2">
          Join the same WiFi as the robot from your system settings, then come back
          here and tap <em>Re-read network status</em>.
        </Typography>
      </Stack>
    </Alert>
  );
}
