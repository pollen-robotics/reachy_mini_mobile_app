/**
 * Manual overboard mode: the telepresence pipe is shut down and the
 * robot session released, so the screen goes blank except for the
 * Bluetooth link status (with signal strength) and the wheels joystick.
 * Commands go straight to the overboard over BLE (stubbed for now).
 */
import { Box, Button, Chip, Stack, Typography } from '@mui/material';
import BluetoothRoundedIcon from '@mui/icons-material/BluetoothRounded';
import BluetoothSearchingRoundedIcon from '@mui/icons-material/BluetoothSearchingRounded';

import { rssiToLevel, type BleLinkSnapshot, type OverboardLinkStats } from '@/features/overboard';
import { LinkQualityBars } from '@/ui/design/LinkQualityBars';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

import { WHEELS_COLOR, glassSurfaceSx } from './glass';
import { Joystick, WheelsIcon } from './joystick';

interface ManualOverboardViewProps {
  ble: BleLinkSnapshot;
  stats: OverboardLinkStats;
  onDeflectionRef: (ref: React.RefObject<{ x: number; y: number }>) => void;
  onRetry: () => void;
}

const STATE_LABEL: Record<BleLinkSnapshot['state'], string> = {
  idle: 'Not connected',
  scanning: 'Searching for overboard…',
  connected: 'Connected',
  error: 'Connection failed',
};

export default function ManualOverboardView({
  ble,
  stats,
  onDeflectionRef,
  onRetry,
}: ManualOverboardViewProps) {
  const connected = ble.state === 'connected';
  return (
    <Stack
      sx={{
        position: 'absolute',
        inset: 0,
        bgcolor: '#000',
        color: '#fff',
        alignItems: 'center',
        justifyContent: 'space-between',
        pt: 'calc(var(--inset-top, env(safe-area-inset-top, 0px)) + 88px)',
        pb: 'calc(var(--inset-bottom, env(safe-area-inset-bottom, 0px)) + 48px)',
        px: 3,
      }}
    >
      <Stack
        spacing={1.5}
        sx={[glassSurfaceSx, { borderRadius: 4, px: 3, py: 2.5, alignItems: 'center', minWidth: 240 }]}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {connected ? (
            <BluetoothRoundedIcon sx={{ color: '#60a5fa' }} />
          ) : (
            <BluetoothSearchingRoundedIcon sx={{ color: 'rgba(255,255,255,0.6)' }} />
          )}
          <Typography sx={{ fontSize: TYPO.md, fontWeight: FONT_WEIGHT.semibold }}>
            {ble.deviceName ?? 'Overboard'}
          </Typography>
          {ble.simulated && (
            <Chip
              label="STUB"
              size="small"
              sx={{ height: 18, fontSize: TYPO.nano, fontWeight: 700, bgcolor: 'rgba(245,158,11,0.3)', color: '#fbbf24' }}
            />
          )}
        </Stack>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <LinkQualityBars
            level={rssiToLevel(ble.rssi)}
            scale={2}
            title={ble.rssi === null ? 'No signal' : `Signal ${ble.rssi} dBm`}
          />
          <Typography sx={{ fontSize: TYPO.xl, fontWeight: FONT_WEIGHT.bold, fontVariantNumeric: 'tabular-nums' }}>
            {ble.rssi === null ? '—' : `${ble.rssi} dBm`}
          </Typography>
        </Stack>
        <Typography sx={{ fontSize: TYPO.xs, color: 'rgba(255,255,255,0.65)' }}>
          {STATE_LABEL[ble.state]}
          {connected ? ` · ${stats.sent} frames sent` : ''}
        </Typography>
        {(ble.state === 'idle' || ble.state === 'error') && (
          <Button size="small" variant="outlined" color="inherit" onClick={onRetry}>
            Connect
          </Button>
        )}
      </Stack>

      <Box>
        <Joystick
          onDeflectionRef={onDeflectionRef}
          enabled={connected}
          size={176}
          label="Wheels"
          disabledLabel={STATE_LABEL[ble.state]}
          gamepadStick="any"
          thumbIcon={<WheelsIcon />}
          thumbColor={WHEELS_COLOR}
        />
      </Box>
    </Stack>
  );
}
