/**
 * Drive the wheeled base straight from the phone over Bluetooth, without
 * Reachy Mini. Reached from the robot list; same base controls and wheels
 * joystick as the telepresence tab, over `useDirectBase` instead of the
 * robot's daemon.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  Box,
  Button,
  FormControlLabel,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';

import { OverboardDriver } from '@/features/overboard/driver';
import { BASE_DEVICE_NAME, isBaseName } from '@/features/overboard/direct-link';
import { useDirectBase } from '@/features/overboard/useDirectBase';
import { useKeepScreenOn } from '@/shared/tauri/useKeepScreenOn';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';
import BaseControls from '@/ui/panels/telepresence/BaseControls';
import { WHEELS_COLOR, glassIconButtonSx, glassSurfaceSx } from '@/ui/panels/telepresence/glass';
import { Joystick, WheelsIcon } from '@/ui/panels/telepresence/joystick';

type DeflectionRef = React.RefObject<{ x: number; y: number }>;

export default function DirectBaseScreen({ onBack }: { onBack: () => void }) {
  const direct = useDirectBase();
  const { base, link, devices, devicesError, address } = direct;
  const connected = base.status?.link.connected ?? false;
  const wheelsEnabled = base.phase === 'balancing';

  const wheelsRef = useRef<DeflectionRef | null>(null);
  const onWheelsRef = useCallback((ref: DeflectionRef) => {
    wheelsRef.current = ref;
  }, []);

  // Drive loop only while the base balances; stopping it sends a STOP burst.
  useEffect(() => {
    if (!wheelsEnabled) return;
    const driver = new OverboardDriver(
      () => wheelsRef.current?.current ?? null,
      () => link
    );
    driver.start();
    return () => driver.stop();
  }, [wheelsEnabled, link]);

  useKeepScreenOn(true);

  const noBaseFound = devices !== null && !devices.some(d => isBaseName(d.name));

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        bgcolor: '#000',
        color: '#fff',
        overflow: 'hidden',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        sx={{
          position: 'absolute',
          top: `calc(${LAYOUT.safeAreaTop} + 12px)`,
          left: 16,
          right: 16,
          alignItems: 'center',
        }}
      >
        <IconButton aria-label="Back" onClick={onBack} sx={glassIconButtonSx}>
          <ArrowBackRoundedIcon />
        </IconButton>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: TYPO.md, fontWeight: FONT_WEIGHT.semibold }}>
            Wheeled base
          </Typography>
          <Typography sx={{ fontSize: TYPO.xs, color: 'rgba(255,255,255,0.7)' }}>
            Direct Bluetooth, without Reachy Mini
          </Typography>
        </Box>
      </Stack>

      <Stack
        spacing={1.5}
        sx={{
          position: 'absolute',
          top: `calc(${LAYOUT.safeAreaTop} + 84px)`,
          left: 16,
          right: 16,
        }}
      >
        {devicesError && (
          <Typography sx={[glassSurfaceSx, { fontSize: TYPO.xs, borderRadius: 2, px: 1.5, py: 1 }]}>
            {devicesError}
          </Typography>
        )}
        {noBaseFound && !connected && (
          <Typography sx={[glassSurfaceSx, { fontSize: TYPO.xs, borderRadius: 2, px: 1.5, py: 1 }]}>
            {direct.scanning
              ? 'Searching for bases nearby…'
              : `No base found. Turn the base on, then tap Scan. A "${BASE_DEVICE_NAME}_<number>" in range shows up here without pairing it first.`}
          </Typography>
        )}
        {devices !== null && !connected && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            {devices.length > 0 && (
              <Select
                size="small"
                value={address ?? ''}
                displayEmpty
                onChange={e => direct.setAddress(String(e.target.value))}
                sx={[
                  glassSurfaceSx,
                  {
                    flex: 1,
                    color: '#fff',
                    borderRadius: 2,
                    '.MuiSvgIcon-root': { color: '#fff' },
                  },
                ]}
                MenuProps={{ sx: { zIndex: 1400 } }}
              >
                <MenuItem value="" disabled>
                  Choose the base
                </MenuItem>
                {devices.map(d => (
                  <MenuItem key={d.address} value={d.address}>
                    {/* Several bases share the name: the address tells them apart. */}
                    {d.name || 'Unnamed'} · {d.address.slice(-5)}
                    {d.bonded === false ? ' · new' : ''}
                  </MenuItem>
                ))}
              </Select>
            )}
            <Box sx={{ flex: devices.length > 0 ? 0 : 1 }} />
            <Button
              size="small"
              disabled={direct.scanning}
              onClick={direct.refreshDevices}
              sx={{ color: '#fff' }}
            >
              {direct.scanning ? 'Scanning…' : 'Scan'}
            </Button>
          </Stack>
        )}
        {direct.firmwareSilent && (
          <Typography sx={[glassSurfaceSx, { fontSize: TYPO.xs, borderRadius: 2, px: 1.5, py: 1 }]}>
            This base runs the stock firmware: it never answers, so there is no live state, tilt or
            battery, and STOP falls back to a sit-down (no instant motor cut). Drive with care.
          </Typography>
        )}
        {address && (
          <Stack direction="row" spacing={2}>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={direct.signs.throttle === -1}
                  onChange={(_, on) => direct.setSigns({ ...direct.signs, throttle: on ? -1 : 1 })}
                />
              }
              label={<Typography sx={{ fontSize: TYPO.xs }}>Reverse forward</Typography>}
            />
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={direct.signs.turn === 1}
                  onChange={(_, on) => direct.setSigns({ ...direct.signs, turn: on ? 1 : -1 })}
                />
              }
              label={<Typography sx={{ fontSize: TYPO.xs }}>Reverse turn</Typography>}
            />
          </Stack>
        )}
        {connected && (
          <Box>
            <Button
              variant="outlined"
              size="small"
              disabled={base.pending !== null}
              onClick={() => base.run('disconnect')}
              sx={{ color: '#fff', borderColor: 'rgba(255,255,255,0.5)' }}
            >
              Disconnect
            </Button>
          </Box>
        )}
      </Stack>

      <Stack
        spacing={1.5}
        sx={{
          position: 'absolute',
          left: 20,
          right: 20,
          bottom: `calc(${LAYOUT.safeAreaBottom} + 28px)`,
          alignItems: 'center',
        }}
      >
        <BaseControls base={base} disabled={false} />
        <Joystick
          onDeflectionRef={onWheelsRef}
          enabled={wheelsEnabled}
          size={180}
          label="Wheels"
          disabledLabel={connected ? 'Stand up first' : 'Not connected'}
          gamepadStick="left"
          thumbIcon={<WheelsIcon />}
          thumbColor={WHEELS_COLOR}
        />
      </Stack>
    </Box>
  );
}
