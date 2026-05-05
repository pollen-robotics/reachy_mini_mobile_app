/**
 * Unified discovery screen.
 *
 * Reached only after the auth gate at the App root, so a HF token
 * is always available here. Two sources are listed side-by-side:
 *
 *   1. **Bluetooth (LAN)** - BLE-advertised Reachy Minis nearby.
 *      Continuously rescanning so the list stays fresh while the user
 *      decides.
 *   2. **Over the internet** - robots registered with Hugging Face
 *      central signaling, polled with the gate-issued token.
 *
 * UX rules:
 *   - Both sections render even when one is empty (the other is
 *     usually populated faster, so we keep the slot reserved with a
 *     skeleton/empty hint instead of letting the layout shift).
 *   - Tapping either a BLE entry or a remote one routes to the
 *     unified `RobotSessionScreen`, which owns the connection
 *     stepper, motor wake/sleep, and post-connect chrome for both
 *     transports.
 *   - Coming back from any flow finds both sections in their last
 *     state (no flash of empty). The remote token is held in
 *     localStorage and the BLE scan resumes via the existing burst
 *     loop.
 *   - Sign-out lives in the remote section header; tapping it
 *     clears the token and the App root drops back to the gate.
 */

import { useEffect, useRef } from 'react';
import {
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  List,
  ListItemButton,
  Stack,
  Typography,
  keyframes,
  useTheme,
} from '@mui/material';
import BluetoothIcon from '@mui/icons-material/Bluetooth';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import LogoutIcon from '@mui/icons-material/Logout';
import RefreshIcon from '@mui/icons-material/Refresh';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import UsbIcon from '@mui/icons-material/Usb';
import WifiIcon from '@mui/icons-material/Wifi';

import { SCAN_TIMEOUT_MS } from '../ble/constants';
import { useBleSession, type ReachyBleDevice } from '../ble/useBleSession';
import {
  extractRobotHardwareId,
  extractRobotId,
  extractRobotName,
  extractRobotTransport,
  type CentralRobotEntry,
} from '../auth/fetchRobotsFromCentral';
import { useRemoteRobots } from '../auth/useRemoteRobots';
import {
  useLocalDaemonProbe,
  type LocalDaemonInfo,
} from '../local/useLocalDaemonProbe';
import { FONT_WEIGHT, LAYOUT, TYPO } from '../styles/tokens';

interface ScanScreenProps {
  onRobotPicked: (device: ReachyBleDevice) => void;
  onRemotePicked: (robot: CentralRobotEntry) => void;
  onSignOutRemote: () => void;
  /**
   * HF token is guaranteed to be present here (the App-level auth
   * gate renders RemoteSignInScreen otherwise). We still pass it
   * through so the remote section can display the username and
   * forward it to `useRemoteRobots`.
   */
  token: string;
  username: string | null;
}

/** Re-trigger the scan a beat before it expires so the stream of
 * advertisements never pauses from the user's perspective. */
const SCAN_REFRESH_MS = Math.max(3_000, SCAN_TIMEOUT_MS - 1_000);

export default function ScanScreen({
  onRobotPicked,
  onRemotePicked,
  onSignOutRemote,
  token,
  username,
}: ScanScreenProps) {
  // BLE discovery is intentionally disabled for now - we are
  // focusing the mobile app on Central listing + connect/disconnect
  // + conversation. The BLE scanning hook, the section rendering
  // and the Wi-Fi setup flow are kept in code (commented JSX +
  // unused imports tree-shaken by Vite) so we can re-enable the
  // first-time Wi-Fi onboarding path without rewriting it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _ble = useBleSession;
  // const { status, devices, adapterUnavailable, startScanning } = useBleSession();
  const remote = useRemoteRobots(token, { pollMs: 30_000 });
  const local = useLocalDaemonProbe();

  // const started = useRef(false);
  // useEffect(() => {
  //   if (started.current) return;
  //   started.current = true;
  //   void startScanning();
  //   const id = window.setInterval(() => {
  //     if (adapterUnavailable) return;
  //     void startScanning({ preserve: true });
  //   }, SCAN_REFRESH_MS);
  //   return () => window.clearInterval(id);
  // }, [startScanning, adapterUnavailable]);

  // const isScanning = status === 'scanning';
  // const bleList = Object.values(devices);
  const remoteRobots =
    remote.state.kind === 'ready' || remote.state.kind === 'loading'
      ? remote.state.robots
      : [];

  // Local USB discovery is also disabled for now - the focus is the
  // central listing path. The probe hook, the section and the
  // matching logic stay in code so it can be reactivated later
  // (e.g. for desktop dev where the loopback daemon is the fastest
  // path to a connected robot).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _local = local;
  // const handleLocalPicked = (info: LocalDaemonInfo): void => {
  //   const match = remoteRobots.find(
  //     (r) => extractRobotName(r) === info.robotName,
  //   );
  //   if (match) {
  //     onRemotePicked(match);
  //     return;
  //   }
  //   onRemotePicked({ name: info.robotName, id: info.robotName });
  // };

  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        overflowY: 'auto',
      }}
    >
      {/* Inner content column. `m: 'auto'` distributes free space
          equally on all four sides → fully centred (both axes) when
          the cards fit within the viewport, and falls back to
          top-aligned scrolling when they don't (the `auto` margins
          collapse to zero once the content overflows, the parent's
          `overflowY` then takes over). The fixed safe-area /
          horizontal paddings are applied to this inner column so
          they don't break the auto-margin centering math. */}
      <Stack
        spacing={2}
        sx={{
          m: 'auto',
          width: '100%',
          maxWidth: LAYOUT.contentMaxWidth,
          px: 3,
          py: LAYOUT.safeAreaTop,
        }}
      >
        <Typography
          component="h1"
          sx={{
            m: 0,
            mb: 1,
            textAlign: 'center',
            fontSize: TYPO.display,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.primary',
            letterSpacing: '-0.3px',
          }}
        >
          Find your Reachy
        </Typography>

        {/* Local USB + BLE sections are hidden for now - the mobile
            app focuses on the Central (HF) listing path. The
            `LocalUsbSection`, `BluetoothSection` and their card
            components stay in this file so re-enabling is a one-line
            revert.
        {local.info && (
          <LocalUsbSection info={local.info} onPick={handleLocalPicked} />
        )}

        <BluetoothSection
          devices={bleList}
          isScanning={isScanning}
          adapterUnavailable={adapterUnavailable}
          onPick={onRobotPicked}
        />
        */}

        <RemoteSection
          username={username}
          state={remote.state}
          onPick={onRemotePicked}
          onSignOut={onSignOutRemote}
          onRefresh={() => void remote.refresh()}
        />
      </Stack>
    </Stack>
  );
}

/* --- Local USB section (loopback / desktop dev) ----------------------- */

function LocalUsbSection({
  info,
  onPick,
}: {
  info: LocalDaemonInfo;
  onPick: (info: LocalDaemonInfo) => void;
}) {
  return (
    <Section
      title="Local USB"
      subtitle="Robots reachable on this device's loopback (127.0.0.1)"
    >
      <List
        disablePadding
        sx={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        <LocalRobotCard info={info} onTap={() => onPick(info)} />
      </List>
    </Section>
  );
}

function LocalRobotCard({
  info,
  onTap,
}: {
  info: LocalDaemonInfo;
  onTap: () => void;
}) {
  return (
    <ListItemButton
      onClick={onTap}
      sx={{
        p: 2,
        borderRadius: 2,
        bgcolor: 'background.paper',
        border: theme => `1px solid ${theme.palette.divider}`,
        '&:hover': {
          bgcolor: 'action.hover',
          borderColor: 'primary.main',
        },
      }}
    >
      <Stack direction="row" alignItems="center" spacing={2} sx={{ width: '100%' }}>
        <Avatar
          sx={{
            bgcolor: 'success.main',
            color: 'success.contrastText',
            width: 40,
            height: 40,
          }}
        >
          <UsbIcon fontSize="small" />
        </Avatar>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" spacing={0.75}>
            <Typography variant="body1" fontWeight={600} noWrap sx={{ minWidth: 0 }}>
              {info.robotName}
            </Typography>
            <ShortId hardwareId={info.hardwareId} />
          </Stack>
          <Typography variant="caption" color="text.secondary" fontFamily="monospace" noWrap>
            127.0.0.1:8000{info.version ? ` · v${info.version}` : ''}
          </Typography>
        </Stack>
        <ChevronRightIcon color="action" />
      </Stack>
    </ListItemButton>
  );
}

/* --- Bluetooth section ------------------------------------------------ */

function BluetoothSection({
  devices,
  isScanning,
  adapterUnavailable,
  onPick,
}: {
  devices: ReachyBleDevice[];
  isScanning: boolean;
  adapterUnavailable: boolean;
  onPick: (d: ReachyBleDevice) => void;
}) {
  return (
    <Section
      title="Wi-Fi (BLE)"
      subtitle="Nearby robots over Bluetooth - tap to set up Wi-Fi"
    >
      {adapterUnavailable ? (
        <SectionEmpty
          text="Bluetooth is off"
          hint="Enable Bluetooth in your device settings to discover nearby Reachy Minis."
        />
      ) : devices.length > 0 ? (
        <List
          disablePadding
          sx={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          {devices.map(device => (
            <BleRobotCard
              key={device.address}
              device={device}
              onTap={() => onPick(device)}
            />
          ))}
        </List>
      ) : (
        <SearchingIndicator scanning={isScanning} />
      )}
    </Section>
  );
}

function BleRobotCard({
  device,
  onTap,
}: {
  device: ReachyBleDevice;
  onTap: () => void;
}) {
  return (
    <ListItemButton
      onClick={onTap}
      sx={{
        p: 2,
        borderRadius: 2,
        bgcolor: 'background.paper',
        border: theme => `1px solid ${theme.palette.divider}`,
        '&:hover': {
          bgcolor: 'action.hover',
          borderColor: 'primary.main',
        },
      }}
    >
      <Stack direction="row" alignItems="center" spacing={2} sx={{ width: '100%' }}>
        <Avatar
          sx={{
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            width: 40,
            height: 40,
          }}
        >
          <BluetoothIcon fontSize="small" />
        </Avatar>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" spacing={0.75}>
            <Typography variant="body1" fontWeight={600} noWrap sx={{ minWidth: 0 }}>
              {device.name}
            </Typography>
            {/* `hardwareId` is parsed from the BLE advertisement TLV
                manufacturer data at scan time, so it is available
                pre-connect. When null (older daemon without TLV
                advert, or no Reachy attached), no chip is rendered -
                we deliberately do NOT fall back to a different id
                space (BLE address) here: a "different id per
                section" was the exact UX confusion this PR closes. */}
            <ShortId hardwareId={device.hardwareId} />
          </Stack>
          <Typography variant="caption" color="text.secondary" fontFamily="monospace">
            {device.rssi ? `${device.rssi} dBm · BLE` : 'BLE'}
          </Typography>
        </Stack>
        <ChevronRightIcon color="action" />
      </Stack>
    </ListItemButton>
  );
}

/* --- Remote (HF central) section ------------------------------------- */

function RemoteSection({
  username,
  state,
  onPick,
  onSignOut,
  onRefresh,
}: {
  username: string | null;
  state: ReturnType<typeof useRemoteRobots>['state'];
  onPick: (robot: CentralRobotEntry) => void;
  onSignOut: () => void;
  onRefresh: () => void;
}) {
  const subtitle = `Connectable via Hugging Face${
    username ? ` · ${username}` : ''
  }`;

  const action = (
    <Stack direction="row" spacing={0.5} alignItems="center">
      {state.kind === 'ready' || state.kind === 'error' ? (
        <IconButton
          size="small"
          aria-label="Refresh remote robots"
          onClick={onRefresh}
        >
          <RefreshIcon fontSize="small" />
        </IconButton>
      ) : null}
      <IconButton
        size="small"
        aria-label="Sign out of Hugging Face"
        onClick={onSignOut}
      >
        <LogoutIcon fontSize="small" />
      </IconButton>
    </Stack>
  );

  return (
    <Section title="Distant (Central)" subtitle={subtitle} action={action}>
      {state.kind === 'loading' && state.robots.length === 0 ? (
        <Stack
          alignItems="center"
          spacing={1}
          sx={{
            py: 2,
            px: 2,
            borderRadius: 2,
            bgcolor: 'action.hover',
            color: 'text.secondary',
          }}
        >
          <CircularProgress size={20} />
          <Typography sx={{ fontSize: TYPO.xs, fontWeight: FONT_WEIGHT.medium }}>
            Asking Hugging Face for your robots…
          </Typography>
        </Stack>
      ) : state.kind === 'error' && state.robots.length === 0 ? (
        <SectionEmpty
          text="Couldn't reach Hugging Face"
          hint={state.reason}
          actionLabel="Retry"
          onAction={onRefresh}
        />
      ) : state.kind !== 'no-token' && state.robots.length > 0 ? (
        <List
          disablePadding
          sx={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          {state.robots.map((robot: CentralRobotEntry) => {
            const id = extractRobotId(robot);
            return (
              <RemoteRobotCard
                key={id ?? Math.random()}
                robot={robot}
                disabled={!id}
                onTap={() => onPick(robot)}
              />
            );
          })}
        </List>
      ) : (
        <SectionEmpty
          text="No robots online"
          hint="None of your Reachy Minis are currently registered with Hugging Face. Power one on and connect it to Wi-Fi."
        />
      )}
    </Section>
  );
}

function RemoteRobotCard({
  robot,
  disabled,
  onTap,
}: {
  robot: CentralRobotEntry;
  disabled: boolean;
  onTap: () => void;
}) {
  const id = extractRobotId(robot);
  const transport = extractRobotTransport(robot);
  const hardwareId = extractRobotHardwareId(robot);
  return (
    <ListItemButton
      disabled={disabled}
      onClick={onTap}
      sx={{
        p: 2,
        borderRadius: 2,
        bgcolor: 'background.paper',
        border: theme => `1px solid ${theme.palette.divider}`,
        '&:hover': {
          bgcolor: 'action.hover',
          borderColor: 'primary.main',
        },
      }}
    >
      <Stack direction="row" alignItems="center" spacing={2} sx={{ width: '100%' }}>
        <Avatar sx={{ bgcolor: 'secondary.main', width: 40, height: 40 }}>
          <SmartToyIcon fontSize="small" />
        </Avatar>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" spacing={0.75} sx={{ minWidth: 0 }}>
            <Typography variant="body1" fontWeight={600} noWrap sx={{ minWidth: 0 }}>
              {extractRobotName(robot)}
            </Typography>
            <TransportChip transport={transport} />
            {/* `hardwareId` from the daemon's ``meta.hardware_id`` is
                stable per physical robot, so we prefer it for the
                user-visible tag. Falls through to a truncated
                ``peerId`` for daemons that haven't shipped PR-1084
                yet (the peerId rotates on reconnect, but it's still
                a sane disambiguator within a single session). */}
            <ShortId hardwareId={hardwareId} fallbackId={id} />
          </Stack>
          <Typography variant="caption" color="text.secondary" fontFamily="monospace" noWrap>
            Signaling
          </Typography>
        </Stack>
        <ChevronRightIcon color="action" />
      </Stack>
    </ListItemButton>
  );
}

/**
 * Render the first 5 chars of the stable per-robot identity
 * (`hardware_id`) as a small monospace tag. A user can use this to
 * recognise a specific robot across sessions even when the
 * `peerId` changes (peer ids rotate on every relay reconnect).
 *
 * Falls back to the first 5 chars of `fallbackId` (typically the
 * `peerId` for central listings) when `hardware_id` is unavailable
 * - daemons older than PR-1084 don't advertise it. Renders nothing
 * when neither is present (e.g. a BLE card pre-connect, where the
 * GATT read hasn't happened yet and there is no `peerId` either).
 *
 * 5 chars on a SHA-256 prefix = 20 bits of entropy, more than enough
 * to disambiguate the robots in a personal fleet without making the
 * tag visually heavy.
 */
function ShortId({
  hardwareId,
  fallbackId,
}: {
  hardwareId: string | null;
  fallbackId?: string | null;
}) {
  const id = hardwareId ?? fallbackId ?? null;
  if (!id) return null;
  return (
    <Typography
      variant="caption"
      sx={{
        fontFamily: 'monospace',
        color: 'text.secondary',
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      id:{id.slice(0, 5)}
    </Typography>
  );
}

/**
 * Small chip rendering the transport tag the daemon advertised on
 * central. Two known values get a typed icon + tinted color; anything
 * else falls through to a generic "label" rendering so a future
 * `"ethernet"` / `"sim"` / `"mockup"` value still shows up legibly
 * without a chip-component update.
 */
function TransportChip({ transport }: { transport: string }) {
  if (transport === 'usb') {
    return (
      <Chip
        size="small"
        icon={<UsbIcon sx={{ fontSize: 14 }} />}
        label="USB"
        variant="outlined"
        sx={{ height: 20, fontSize: 11, '.MuiChip-icon': { ml: 0.5 } }}
      />
    );
  }
  if (transport === 'wifi') {
    return (
      <Chip
        size="small"
        icon={<WifiIcon sx={{ fontSize: 14 }} />}
        label="Wi-Fi"
        variant="outlined"
        sx={{ height: 20, fontSize: 11, '.MuiChip-icon': { ml: 0.5 } }}
      />
    );
  }
  return (
    <Chip
      size="small"
      label={transport}
      variant="outlined"
      sx={{ height: 20, fontSize: 11, textTransform: 'capitalize' }}
    />
  );
}

/* --- Reusable section frame ------------------------------------------ */

function Section({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Stack spacing={1.25} sx={{ width: '100%', mt: 1 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ width: '100%' }}
      >
        <Stack sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            sx={{
              fontSize: TYPO.lg,
              fontWeight: FONT_WEIGHT.semibold,
              color: 'text.primary',
            }}
          >
            {title}
          </Typography>
          <Typography
            sx={{
              fontSize: TYPO.xs,
              color: 'text.secondary',
            }}
            noWrap
          >
            {subtitle}
          </Typography>
        </Stack>
        {action}
      </Stack>
      {children}
    </Stack>
  );
}

function SectionEmpty({
  text,
  hint,
  actionLabel,
  onAction,
}: {
  text: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <Stack
      alignItems="center"
      spacing={1}
      sx={{
        py: 2,
        px: 2,
        borderRadius: 2,
        bgcolor: 'action.hover',
        color: 'text.secondary',
        textAlign: 'center',
      }}
    >
      <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium }}>
        {text}
      </Typography>
      {hint ? (
        <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>
          {hint}
        </Typography>
      ) : null}
      {actionLabel && onAction ? (
        <Button
          size="small"
          variant="text"
          onClick={onAction}
          sx={{ textTransform: 'none' }}
        >
          {actionLabel}
        </Button>
      ) : null}
    </Stack>
  );
}

/* --- Searching indicator --------------------------------------------- */

function SearchingIndicator({ scanning }: { scanning: boolean }) {
  const theme = useTheme();
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{
        px: 2,
        py: 1.5,
        borderRadius: 2,
        bgcolor: 'action.hover',
        color: 'text.secondary',
      }}
    >
      <Box sx={{ display: 'inline-flex', gap: 0.75, alignItems: 'center' }}>
        {[0, 0.15, 0.3].map(delay => (
          <Box
            key={delay}
            sx={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              bgcolor: scanning ? theme.palette.primary.main : theme.palette.text.disabled,
              animation: scanning ? `${pulseKf} 1.2s ${delay}s infinite` : 'none',
            }}
          />
        ))}
      </Box>
      <Typography sx={{ fontSize: TYPO.xs, fontWeight: FONT_WEIGHT.medium }}>
        {scanning ? 'Scanning for nearby robots…' : 'Waiting…'}
      </Typography>
    </Stack>
  );
}

/* --- Animations ------------------------------------------------------- */

const pulseKf = keyframes`
  0%, 80%, 100% { opacity: 0.2; transform: scale(0.7); }
  40% { opacity: 1; transform: scale(1); }
`;
