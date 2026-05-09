/**
 * PIN entry view, shared by both the first-time setup flow (intent
 * `'connect'`) and the re-provisioning forget flow (intent
 * `'forget'`). The component is intentionally identical between the
 * two flows so the user never sees a "different PIN screen"; only
 * the surrounding subtitle changes to reflect the intent.
 */
import { Box, CircularProgress, Stack, Typography } from '@mui/material';

import PinInput, { PIN_INPUT_LENGTH } from '@/ui/design/PinInput';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

export function PinView({
  pin,
  onPinChange,
  onComplete,
  error,
  isBusy,
  intent = 'connect',
  currentSsid = null,
}: {
  pin: string;
  onPinChange: (v: string) => void;
  onComplete: (v: string) => void;
  error: string | null;
  isBusy: boolean;
  /**
   * What the PIN gates here. `'connect'` (default) is the first-time
   * setup → leads to scan/PSK/connect. `'forget'` is the
   * re-provisioning flow from `AlreadyOnlineView` → leads to
   * `WIFI_FORGET`.
   */
  intent?: 'connect' | 'forget';
  /** SSID the robot reports it's currently on. Surfaced only in the
   * `forget` intent's subtitle so the user gets an explicit
   * confirmation of the network they are about to drop. */
  currentSsid?: string | null;
}) {
  return (
    <Stack alignItems="center" spacing={2.5} sx={{ width: '100%' }}>
      {/* No hero illustration here: the PinInput boxes ARE the
          visual focal point of this view. A locked-reachy figure
          on top would compete for attention with the entry field
          the user is actively trying to fill in. */}
      <Typography
        sx={{
          fontSize: TYPO.lg,
          fontWeight: FONT_WEIGHT.semibold,
          textAlign: 'center',
        }}
      >
        {intent === 'forget' ? 'Confirm with the PIN' : 'Enter the PIN'}
      </Typography>
      <Typography
        sx={{ fontSize: TYPO.sm, color: 'text.secondary', textAlign: 'center' }}
      >
        {intent === 'forget' ? (
          <>
            The robot will drop&nbsp;
            <Box component="span" sx={{ fontWeight: FONT_WEIGHT.semibold }}>
              {currentSsid ? `"${currentSsid}"` : 'its current network'}
            </Box>
            &nbsp;and reopen its hotspot. {PIN_INPUT_LENGTH} digits printed on
            the underside of the robot.
          </>
        ) : (
          <>
            {PIN_INPUT_LENGTH} digits printed on the underside of the robot.
          </>
        )}
      </Typography>
      <PinInput
        value={pin}
        onChange={onPinChange}
        onComplete={onComplete}
        disabled={isBusy}
        hasError={!!error}
      />
      {/* Helper text strip. PinInput auto-submits at exactly
          PIN_INPUT_LENGTH digits, hence no explicit "Continue" button. */}
      <Box sx={{ minHeight: 20, textAlign: 'center' }}>
        {error ? (
          <Typography sx={{ fontSize: TYPO.xs, color: 'error.main' }}>
            {error}
          </Typography>
        ) : isBusy ? (
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            justifyContent="center"
          >
            <CircularProgress size={14} />
            <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>
              Authenticating…
            </Typography>
          </Stack>
        ) : null}
      </Box>
    </Stack>
  );
}
