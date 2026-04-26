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

import { SCAN_TIMEOUT_MS } from '../ble/constants';
import { useBleSession, type ReachyBleDevice } from '../ble/useBleSession';
import {
  extractRobotId,
  extractRobotName,
  type CentralRobotEntry,
} from '../auth/fetchRobotsFromCentral';
import {
  useCentralSource,
  type CentralSourceState,
} from '../presence/centralSource';
import type { ConnectionDiagnostic } from '../presence/types';
import HeroIllustration from '../components/HeroIllustration';
import detectiveSvg from '../assets/reachy-detective.svg';
import reachiesSvg from '../assets/reachies.svg';
import { FONT_WEIGHT, LAYOUT, TYPO } from '../styles/tokens';

interface ScanScreenProps {
  onRobotPicked: (device: ReachyBleDevice) => void;
  onRemotePicked: (robot: CentralRobotEntry) => void;
  onSignOutRemote: () => void;
  /**
   * HF token is guaranteed to be present here (the App-level auth
   * gate renders RemoteSignInScreen otherwise). We still pass it
   * through so the remote section can display the username and
   * forward it to `useCentralSource`.
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
  const { status, devices, adapterUnavailable, startScanning } = useBleSession();
  const remote = useCentralSource(token);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void startScanning();
    const id = window.setInterval(() => {
      if (adapterUnavailable) return;
      void startScanning({ preserve: true });
    }, SCAN_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [startScanning, adapterUnavailable]);

  const isScanning = status === 'scanning';
  const bleList = Object.values(devices);
  const hasAnyRobot =
    bleList.length > 0 ||
    (remote.state.kind === 'ready' && remote.state.robots.length > 0) ||
    (remote.state.kind === 'loading' && remote.state.robots.length > 0);

  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        px: 3,
        pt: LAYOUT.safeAreaTop,
        pb: 4,
        overflowY: 'auto',
      }}
    >
      <Stack
        spacing={2}
        alignItems="center"
        sx={{ width: '100%', maxWidth: LAYOUT.contentMaxWidth, mx: 'auto' }}
      >
        <HeroIllustration
          src={hasAnyRobot ? reachiesSvg : detectiveSvg}
          alt={hasAnyRobot ? 'Reachy Minis found' : 'Looking for Reachy Minis'}
          animation="float"
          size={hasAnyRobot ? 120 : 140}
          mb={1}
        />
        <Typography
          sx={{
            fontSize: TYPO.display,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.primary',
            textAlign: 'center',
            letterSpacing: '-0.3px',
          }}
        >
          {hasAnyRobot ? 'Choose your Reachy' : 'Looking for your Reachy'}
        </Typography>

        <BluetoothSection
          devices={bleList}
          isScanning={isScanning}
          adapterUnavailable={adapterUnavailable}
          onPick={onRobotPicked}
        />

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
    <Section title="Bluetooth" subtitle="Nearby robots on the local network">
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
          <Typography variant="body1" fontWeight={600} noWrap>
            {device.name}
          </Typography>
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
  state: CentralSourceState;
  onPick: (robot: CentralRobotEntry) => void;
  onSignOut: () => void;
  onRefresh: () => void;
}) {
  const subtitle = `Signed in${
    username ? ` as ${username}` : ''
  } · Hugging Face central`;

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
    <Section title="Over the internet" subtitle={subtitle} action={action}>
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
        <DiagnosticEmpty
          diagnostic={state.diagnostic}
          onRefresh={onRefresh}
          onSignOut={onSignOut}
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
          <Typography variant="body1" fontWeight={600} noWrap>
            {extractRobotName(robot)}
          </Typography>
          <Typography variant="caption" color="text.secondary" fontFamily="monospace" noWrap>
            {id ? `${id.slice(0, 8)}… · Signaling` : 'no peerId'}
          </Typography>
        </Stack>
        <ChevronRightIcon color="action" />
      </Stack>
    </ListItemButton>
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

/**
 * Render the central diagnostic with an action button picked from
 * the typed `kind`. Token rejection routes the user to the sign-in
 * gate; everything else offers a retry.
 */
function DiagnosticEmpty({
  diagnostic,
  onRefresh,
  onSignOut,
}: {
  diagnostic: ConnectionDiagnostic;
  onRefresh: () => void;
  onSignOut: () => void;
}) {
  switch (diagnostic.kind) {
    case 'token_rejected':
      return (
        <SectionEmpty
          text="Hugging Face rejected your token"
          hint="Sign in again to refresh your access."
          actionLabel="Sign in"
          onAction={onSignOut}
        />
      );
    case 'network_error':
      return (
        <SectionEmpty
          text="Network unreachable"
          hint="Check your connection and try again."
          actionLabel="Retry"
          onAction={onRefresh}
        />
      );
    case 'timeout':
      return (
        <SectionEmpty
          text="Hugging Face took too long"
          hint="The request timed out. Try again in a moment."
          actionLabel="Retry"
          onAction={onRefresh}
        />
      );
    case 'http_5xx':
      return (
        <SectionEmpty
          text="Hugging Face is having trouble"
          hint={`Server returned HTTP ${diagnostic.status}. Try again shortly.`}
          actionLabel="Retry"
          onAction={onRefresh}
        />
      );
    case 'http_4xx':
      return (
        <SectionEmpty
          text="Hugging Face refused the request"
          hint={`Returned HTTP ${diagnostic.status}.`}
          actionLabel="Retry"
          onAction={onRefresh}
        />
      );
    case 'permission_denied':
      return (
        <SectionEmpty
          text="Permission required"
          hint={diagnostic.message}
        />
      );
    case 'empty_list':
    case 'unknown':
    default:
      return (
        <SectionEmpty
          text="Couldn't reach Hugging Face"
          hint={diagnostic.message}
          actionLabel="Retry"
          onAction={onRefresh}
        />
      );
  }
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
