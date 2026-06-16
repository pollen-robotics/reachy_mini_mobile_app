/**
 * First-time setup wizard.
 *
 * Provisions a brand-new Reachy Mini Wireless onto the user's Wi-Fi over
 * Bluetooth only (the user never joins the robot's hotspot). Reached from the
 * "Set up a new Reachy" CTA on `ScanScreen`; on success it hands the freshly
 * registered robot back to the host for a normal session.
 *
 * The flow is owned by `useSetupMachine` (FSM + BLE/crypto orchestration).
 * This file is the presentation layer: a shared shell (4-step header +
 * back/cancel) plus one view per phase. Subcomponents live in this file by
 * the same convention as `ScanScreen.tsx`.
 *
 * See `docs/FIRST_TIME_SETUP_PLAN.md` for the design rationale and the ASCII
 * mockups this implements.
 */

import { useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  Stack,
  TextField,
  Typography,
  alpha,
} from '@mui/material';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import BluetoothSearchingIcon from '@mui/icons-material/BluetoothSearching';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import WifiIcon from '@mui/icons-material/Wifi';
import WifiLockIcon from '@mui/icons-material/WifiLock';

import connectionUrl from '@/assets/connection.svg';
import type { BleDevice } from '@/features/ble/bleWifi';
import { useSetupMachine, type SetupMachine } from '@/features/ble-provisioning/useSetupMachine';
import { type SetupResult } from '@/features/ble-provisioning/types';
import { LinkQualityBars, type LinkQuality } from '@/ui/design/LinkQualityBars';
import RobotAvatar from '@/ui/design/RobotAvatar';
import { FONT_WEIGHT, LAYOUT, RADIUS, STATUS, TYPO } from '@/ui/design/tokens';

/** The PIN printed under the robot is the 5-char serial suffix. */
const PIN_LENGTH = 5;

interface SetupWizardScreenProps {
  token: string;
  /** Leave the wizard and return to the robot list. */
  onCancel: () => void;
  /** Provisioning finished. `result.robot` is the central listing when it
   *  appeared in time (→ open a session), else null (→ back to the list). */
  onComplete: (result: SetupResult) => void;
}

export default function SetupWizardScreen({ token, onCancel, onComplete }: SetupWizardScreenProps) {
  const m = useSetupMachine({ token });

  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        bgcolor: 'background.default',
        color: 'text.primary',
      }}
    >
      {/* Top bar: a single back/close affordance. Back always exits the
          wizard - BLE teardown is handled on unmount by the FSM. */}
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          pt: `calc(${LAYOUT.safeAreaTop} + 12px)`,
          pb: 1,
          px: 1,
        }}
      >
        <Button
          aria-label="Cancel setup"
          onClick={onCancel}
          startIcon={<ArrowBackIosNewIcon sx={{ fontSize: 16 }} />}
          sx={{
            color: 'text.secondary',
            textTransform: 'none',
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: TYPO.sm,
            borderRadius: 999,
          }}
        >
          Back
        </Button>
      </Stack>

      {/* Scrollable content column. */}
      <Stack sx={{ flex: 1, minHeight: 0, width: '100%', overflowY: 'auto' }}>
        <Stack
          sx={{
            m: 'auto',
            width: '100%',
            maxWidth: LAYOUT.contentMaxWidth,
            px: 3,
            py: 3,
            alignItems: 'center',
          }}
        >
          <StepView m={m} onCancel={onCancel} onComplete={onComplete} />
        </Stack>
      </Stack>
    </Stack>
  );
}

/* --- step router ---------------------------------------------------------- */

function StepView({
  m,
  onCancel,
  onComplete,
}: {
  m: SetupMachine;
  onCancel: () => void;
  onComplete: (result: SetupResult) => void;
}) {
  if (m.phase === 'error' && m.error) {
    return <ErrorView message={m.error.message} onRetry={m.retry} onCancel={onCancel} />;
  }
  switch (m.phase) {
    case 'permission':
      return <PermissionView onContinue={m.startScanning} />;
    case 'scanning':
      return <ScanView devices={m.devices} scanning={m.scanning} onPick={m.selectDevice} onRescan={m.rescan} />;
    case 'connecting':
      return <BusyView title="Connecting to your Reachy" caption="Opening a Bluetooth link…" />;
    case 'pin':
      return <PinView onSubmit={m.submitPin} />;
    case 'authenticating':
      return <BusyView title="Verifying" caption="Checking the setup code…" />;
    case 'wifi-scanning':
      return <BusyView title="Choosing a network" caption="Scanning for Wi-Fi networks (this can take ~10 s)…" />;
    case 'wifi-pick':
      return <WifiPickView networks={m.networks} onPick={m.selectNetwork} onRescan={m.rescanWifi} />;
    case 'wifi-password':
      return <PasswordView ssid={m.selectedSsid ?? ''} onSubmit={m.submitPassword} />;
    case 'wifi-connecting':
      return <ConnectingView ssid={m.selectedSsid ?? ''} stage="joining" />;
    case 'linking-account':
      return <LinkAccountView onLink={m.linkAccount} />;
    case 'central-waiting':
      return <ConnectingView ssid={m.selectedSsid ?? ''} stage="registering" />;
    case 'done':
      return <SuccessView result={m.result} onComplete={onComplete} onBackToList={onCancel} />;
    default:
      return null;
  }
}

/* --- shared bits ---------------------------------------------------------- */

function Headline({ title, caption }: { title: string; caption?: string }) {
  return (
    <Stack spacing={0.75} sx={{ alignItems: 'center', textAlign: 'center' }}>
      <Typography sx={{ fontSize: TYPO.xl, fontWeight: FONT_WEIGHT.semibold }}>{title}</Typography>
      {caption ? (
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', maxWidth: 300, lineHeight: 1.5 }}>
          {caption}
        </Typography>
      ) : null}
    </Stack>
  );
}

function PrimaryButton(props: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="contained"
      fullWidth
      {...props}
      sx={{
        textTransform: 'none',
        fontSize: TYPO.md,
        fontWeight: FONT_WEIGHT.semibold,
        borderRadius: `${RADIUS.md}px`,
        py: 1.25,
        ...props.sx,
      }}
    />
  );
}

function SecondaryButton(props: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outlined"
      fullWidth
      {...props}
      sx={{
        textTransform: 'none',
        fontSize: TYPO.md,
        fontWeight: FONT_WEIGHT.semibold,
        borderRadius: `${RADIUS.md}px`,
        py: 1.25,
        ...props.sx,
      }}
    />
  );
}

function IconHero({ children, tint }: { children: React.ReactNode; tint?: string }) {
  return (
    <Box
      sx={{
        width: LAYOUT.heroSizeSmall,
        height: LAYOUT.heroSizeSmall,
        borderRadius: RADIUS.circle,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: theme => alpha(tint ?? theme.palette.primary.main, 0.1),
        color: tint ?? 'primary.main',
      }}
    >
      {children}
    </Box>
  );
}

/* --- 1. permission primer ------------------------------------------------- */

function PermissionView({ onContinue }: { onContinue: () => void }) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero>
        <BluetoothSearchingIcon sx={{ fontSize: 52 }} />
      </IconHero>
      <Headline
        title="Connect over Bluetooth"
        caption="To set up a new Reachy we use Bluetooth to send it your Wi-Fi details. Your Wi-Fi password is encrypted on your phone before being sent, so it is never transmitted in clear - and it is never stored."
      />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <SecondaryButton onClick={onContinue}>Continue</SecondaryButton>
      </Box>
    </Stack>
  );
}

/* --- 2. BLE scan ---------------------------------------------------------- */

function ScanView({
  devices,
  scanning,
  onPick,
  onRescan,
}: {
  devices: BleDevice[];
  scanning: boolean;
  onPick: (d: BleDevice) => void;
  onRescan: () => void;
}) {
  const hasDevices = devices.length > 0;
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline
        title="Looking for new Reachies"
        caption={scanning ? 'Scanning over Bluetooth…' : 'Tap your robot to start the setup.'}
      />
      {scanning && !hasDevices ? (
        <CircularProgress size={28} sx={{ color: 'text.secondary' }} />
      ) : null}

      {hasDevices ? (
        <List disablePadding sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          {devices.map((d, i) => (
            <DeviceRow
              key={d.address}
              device={d}
              isClosest={devices.length > 1 && i === 0 && typeof d.rssi === 'number'}
              onTap={() => onPick(d)}
            />
          ))}
        </List>
      ) : !scanning ? (
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', textAlign: 'center', maxWidth: 300 }}>
          No Reachy found. Make sure it is powered on and held close to the phone, then scan again.
        </Typography>
      ) : null}

      <Button
        onClick={onRescan}
        startIcon={<RefreshIcon />}
        disabled={scanning}
        sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold }}
      >
        {scanning ? 'Scanning…' : 'Scan again'}
      </Button>
    </Stack>
  );
}

/**
 * Map a BLE advertisement RSSI (negative dBm, closer to 0 = stronger) to
 * the 3-bar {@link LinkQuality} scale. The breakpoints mirror the usual
 * "near / same room / far" buckets for BLE proximity. A missing RSSI
 * (some Android stacks omit it) renders muted/empty bars.
 */
function rssiToLevel(rssi: number | undefined): LinkQuality {
  if (typeof rssi !== 'number') return 0;
  if (rssi >= -60) return 3;
  if (rssi >= -72) return 2;
  return 1;
}

function DeviceRow({
  device,
  isClosest = false,
  onTap,
}: {
  device: BleDevice;
  isClosest?: boolean;
  onTap: () => void;
}) {
  const label = device.name && device.name.trim().length > 0 ? device.name : 'Reachy';
  const hasRssi = typeof device.rssi === 'number';
  return (
    <ListItemButton
      onClick={onTap}
      sx={{
        p: 1.5,
        borderRadius: '14px',
        bgcolor: 'background.paper',
        border: theme =>
          `1px solid ${isClosest ? alpha(theme.palette.primary.main, 0.5) : theme.palette.divider}`,
      }}
    >
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', width: '100%' }}>
        <RobotAvatar size={44} />
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: TYPO.md, fontWeight: FONT_WEIGHT.semibold }} noWrap>
            {label}
          </Typography>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Typography
              sx={{ fontSize: TYPO.xs, fontFamily: 'monospace', color: 'text.secondary', opacity: 0.6 }}
              noWrap
            >
              #{device.address.slice(0, 8)}
            </Typography>
            {isClosest ? (
              <Typography
                sx={{ fontSize: TYPO.xs, fontWeight: FONT_WEIGHT.semibold, color: 'primary.main' }}
                noWrap
              >
                · Closest
              </Typography>
            ) : null}
          </Stack>
        </Stack>
        {hasRssi ? (
          <Box sx={{ flexShrink: 0 }}>
            <LinkQualityBars
              level={rssiToLevel(device.rssi)}
              title={`Signal strength: ${device.rssi} dBm`}
              scale={1.25}
            />
          </Box>
        ) : null}
        <ChevronRightIcon sx={{ color: 'primary.main', flexShrink: 0 }} />
      </Stack>
    </ListItemButton>
  );
}

/* --- 3. PIN --------------------------------------------------------------- */

function PinView({ onSubmit }: { onSubmit: (pin: string) => void }) {
  const [pin, setPin] = useState('');
  const ready = pin.length === PIN_LENGTH;
  const submit = () => {
    if (ready) onSubmit(pin);
  };
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero>
        <LockOutlinedIcon sx={{ fontSize: 48 }} />
      </IconHero>
      <Headline title="Enter the setup code" caption="Find the 5-character code printed under your Reachy." />
      <TextField
        value={pin}
        onChange={e => setPin(e.target.value.replace(/\s/g, '').slice(0, PIN_LENGTH))}
        onKeyDown={e => {
          if (e.key === 'Enter') submit();
        }}
        autoFocus
        slotProps={{
          htmlInput: {
            inputMode: 'text',
            autoCapitalize: 'characters',
            'aria-label': 'Setup code',
            style: {
              textAlign: 'center',
              fontFamily: 'monospace',
              fontSize: '1.8rem',
              letterSpacing: '0.5rem',
              fontWeight: 600,
            },
          },
        }}
        sx={{ width: 240 }}
      />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={submit} disabled={!ready}>
          Verify
        </PrimaryButton>
      </Box>
    </Stack>
  );
}

/* --- 4. Wi-Fi pick -------------------------------------------------------- */

function WifiPickView({
  networks,
  onPick,
  onRescan,
}: {
  networks: string[];
  onPick: (ssid: string) => void;
  onRescan: () => void;
}) {
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline title="Choose a Wi-Fi network" caption="Pick the network your Reachy should join." />
      {networks.length > 0 ? (
        <List disablePadding sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {networks.map(ssid => (
            <ListItemButton
              key={ssid}
              onClick={() => onPick(ssid)}
              sx={{
                p: 1.5,
                borderRadius: '12px',
                bgcolor: 'background.paper',
                border: theme => `1px solid ${theme.palette.divider}`,
              }}
            >
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', width: '100%' }}>
                <WifiLockIcon sx={{ color: 'text.secondary', fontSize: 20 }} />
                <Typography sx={{ flex: 1, minWidth: 0, fontSize: TYPO.md }} noWrap>
                  {ssid}
                </Typography>
                <ChevronRightIcon sx={{ color: 'primary.main', flexShrink: 0 }} />
              </Stack>
            </ListItemButton>
          ))}
        </List>
      ) : (
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', textAlign: 'center', maxWidth: 300 }}>
          No networks found nearby. Move the robot closer to your router and rescan.
        </Typography>
      )}
      <Button onClick={onRescan} startIcon={<RefreshIcon />} sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold }}>
        Rescan
      </Button>
    </Stack>
  );
}

/* --- 5. password ---------------------------------------------------------- */

function PasswordView({ ssid, onSubmit }: { ssid: string; onSubmit: (psk: string) => void }) {
  const [psk, setPsk] = useState('');
  const [show, setShow] = useState(false);
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero>
        <WifiIcon sx={{ fontSize: 48 }} />
      </IconHero>
      <Headline title="Connect to" caption={ssid} />
      <TextField
        value={psk}
        onChange={e => setPsk(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && psk.length > 0) onSubmit(psk);
        }}
        type={show ? 'text' : 'password'}
        label="Wi-Fi password"
        autoFocus
        fullWidth
        sx={{ maxWidth: 320 }}
        slotProps={{
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  aria-label={show ? 'Hide password' : 'Show password'}
                  onClick={() => setShow(s => !s)}
                  edge="end"
                  size="small"
                >
                  {show ? <VisibilityOffIcon /> : <VisibilityIcon />}
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', color: 'text.secondary' }}>
        <LockOutlinedIcon sx={{ fontSize: 14 }} />
        <Typography sx={{ fontSize: TYPO.xs }}>Encrypted on this phone before it's sent</Typography>
      </Stack>
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={() => onSubmit(psk)} disabled={psk.length === 0}>
          Connect
        </PrimaryButton>
      </Box>
    </Stack>
  );
}

/* --- 6. connecting / central-waiting -------------------------------------- */

function ConnectingView({ ssid, stage }: { ssid: string; stage: 'joining' | 'registering' }) {
  const title = stage === 'joining' ? 'Connecting your Reachy' : 'Almost ready…';
  const caption =
    stage === 'joining'
      ? `Joining ${ssid || 'the network'}…`
      : 'Registering with Hugging Face…';
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Box component="img" src={connectionUrl} alt="" aria-hidden sx={{ width: 132, height: 132 }} />
      <Headline title={title} caption={caption} />
      <CircularProgress size={26} sx={{ color: 'primary.main' }} />
    </Stack>
  );
}

/* --- 6b. link account (robot-side Hugging Face OAuth) --------------------- */

function LinkAccountView({ onLink }: { onLink: () => void }) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Box component="img" src={connectionUrl} alt="" aria-hidden sx={{ width: 132, height: 132 }} />
      <Headline
        title="Link your Reachy"
        caption="Sign in with Hugging Face so your Reachy can come online. We'll open your browser — keep this phone on the same Wi-Fi as the robot."
      />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={onLink}>Sign in with Hugging Face</PrimaryButton>
      </Box>
    </Stack>
  );
}

/* --- 7. success ----------------------------------------------------------- */

function SuccessView({
  result,
  onComplete,
  onBackToList,
}: {
  result: SetupResult | null;
  onComplete: (result: SetupResult) => void;
  onBackToList: () => void;
}) {
  const robot = result?.robot ?? null;
  const name = robot?.meta?.name ?? robot?.name ?? 'Your Reachy';
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Box sx={{ position: 'relative' }}>
        <RobotAvatar size={96} />
        <CheckCircleIcon
          sx={{
            position: 'absolute',
            right: -4,
            bottom: -4,
            fontSize: 32,
            color: STATUS.success,
            bgcolor: 'background.default',
            borderRadius: RADIUS.circle,
          }}
        />
      </Box>
      <Headline
        title={robot ? `${name} is online!` : "Wi-Fi set up!"}
        caption={
          robot
            ? 'Ready to use over Wi-Fi.'
            : "Your Reachy joined the network. It will show up in your list in a few moments."
        }
      />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        {robot ? (
          <Stack spacing={1.25}>
            <PrimaryButton onClick={() => result && onComplete(result)}>{`Open ${name}`}</PrimaryButton>
            <Button onClick={onBackToList} sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold }}>
              Back to all Reachies
            </Button>
          </Stack>
        ) : (
          <PrimaryButton onClick={onBackToList}>Back to all Reachies</PrimaryButton>
        )}
      </Box>
    </Stack>
  );
}

/* --- error ---------------------------------------------------------------- */

function ErrorView({
  message,
  onRetry,
  onCancel,
}: {
  message: string;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero tint={STATUS.error}>
        <ErrorOutlineIcon sx={{ fontSize: 48 }} />
      </IconHero>
      <Headline title="Something went wrong" caption={message} />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <Stack spacing={1.25}>
          <PrimaryButton onClick={onRetry}>Try again</PrimaryButton>
          <Button onClick={onCancel} sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold }}>
            Cancel setup
          </Button>
        </Stack>
      </Box>
    </Stack>
  );
}

/* --- generic busy --------------------------------------------------------- */

function BusyView({ title, caption }: { title: string; caption?: string }) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <CircularProgress size={32} sx={{ color: 'primary.main' }} />
      <Headline title={title} caption={caption} />
    </Stack>
  );
}
