/**
 * Transient view shown while the BLE link comes up and we cross-check
 * NETWORK_STATUS + WIFI_STATUS to decide where to route. Identical
 * spinner-only treatment as ``InFlightView`` so all "in-progress"
 * views feel coherent across the wizard.
 */
import { CircularProgress, Stack, Typography } from '@mui/material';

import { FONT_WEIGHT, TYPO } from '../../styles/tokens';

export function PreparingView({ bleStatus }: { bleStatus: string }) {
  const caption =
    bleStatus === 'error'
      ? 'Bluetooth error - try going back.'
      : bleStatus === 'connecting'
        ? 'Connecting over Bluetooth…'
        : 'Reading robot status…';
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
        Preparing setup
      </Typography>
      <Typography
        sx={{ fontSize: TYPO.sm, color: 'text.secondary', textAlign: 'center' }}
      >
        {caption}
      </Typography>
    </Stack>
  );
}
