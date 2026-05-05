/**
 * Generic "BLE round-trip in flight" view shared by both connecting
 * and forgetting flows. Both share the same UX shape: the daemon
 * ACK'd the BLE command, the actual nmcli work runs async on the
 * Pi, and we are about to drop the BLE link and bounce. The display
 * differs only in copy.
 *
 * Same minimalist spinner-only treatment as ``PreparingView`` so all
 * in-flight views feel coherent across the wizard.
 */
import { CircularProgress, Stack, Typography } from '@mui/material';

import { FONT_WEIGHT, TYPO } from '../../styles/tokens';

function InFlightView({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <Stack alignItems="center" spacing={2.5} sx={{ width: '100%' }}>
      <CircularProgress size={56} thickness={3.5} />
      <Typography
        sx={{
          fontSize: TYPO.lg,
          fontWeight: FONT_WEIGHT.semibold,
          textAlign: 'center',
        }}
      >
        {title}
      </Typography>
      <Typography
        sx={{ fontSize: TYPO.sm, color: 'text.secondary', textAlign: 'center' }}
      >
        {subtitle}
      </Typography>
    </Stack>
  );
}

export function ConnectingView({ ssid }: { ssid: string | null }) {
  return (
    <InFlightView
      title={`Joining ${ssid ?? 'the network'}`}
      subtitle="The robot will appear in your list once it's online."
    />
  );
}

export function ForgettingView({ ssid }: { ssid: string | null }) {
  return (
    <InFlightView
      title={`Forgetting ${ssid ? `"${ssid}"` : 'the network'}`}
      subtitle="The robot will reopen its hotspot in a moment."
    />
  );
}

/**
 * Shown after WIFI_CONNECT was ACK'd. We sit here until the robot
 * has both:
 *   1. committed locally to the picked SSID (BLE WIFI_STATUS), and
 *   2. checked in with HF central with a heartbeat that post-dates
 *      the moment we triggered WIFI_CONNECT.
 *
 * Sub-second-to-~30 s in practice; the 60 s watchdog only fires on
 * a genuinely stuck stack.
 */
export function VerifyingView({ ssid }: { ssid: string | null }) {
  return (
    <InFlightView
      title={`Joining ${ssid ?? 'the network'}`}
      subtitle="Waiting for your Reachy to come online with Hugging Face."
    />
  );
}
