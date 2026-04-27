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

import { useEffect, useMemo, useRef } from 'react';
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
import LaptopMacIcon from '@mui/icons-material/LaptopMac';
import LogoutIcon from '@mui/icons-material/Logout';
import RefreshIcon from '@mui/icons-material/Refresh';
import SmartToyIcon from '@mui/icons-material/SmartToy';

import { SCAN_TIMEOUT_MS } from '../ble/constants';
import { useBleSession, type ReachyBleDevice } from '../ble/useBleSession';
import {
  extractInstallId,
  extractRobotId,
  extractRobotName,
  type CentralRobotEntry,
} from '../auth/fetchRobotsFromCentral';
import {
  useCentralSource,
  type CentralSourceState,
} from '../presence/centralSource';
import {
  useLocalDaemonSource,
  type LocalDaemonInfo,
} from '../presence/localDaemonSource';
import type { ConnectionDiagnostic } from '../presence/types';
import HeroIllustration from '../components/HeroIllustration';
import detectiveSvg from '../assets/reachy-detective.svg';
import reachiesSvg from '../assets/reachies.svg';
import { FONT_WEIGHT, LAYOUT, TYPO } from '../styles/tokens';

interface ScanScreenProps {
  onRobotPicked: (device: ReachyBleDevice) => void;
  onRemotePicked: (robot: CentralRobotEntry) => void;
  /**
   * Routed when the user taps a row in the "Reachy Mini tray (this Mac)"
   * section. Only ever fires on builds where a daemon answers on
   * `127.0.0.1:8000` (typically the desktop tray app on the same machine).
   */
  onLocalhostPicked: (daemon: LocalDaemonInfo) => void;
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
  onLocalhostPicked,
  onSignOutRemote,
  token,
  username,
}: ScanScreenProps) {
  const { status, devices, adapterUnavailable, startScanning } = useBleSession();
  const remote = useCentralSource(token);
  const localDaemon = useLocalDaemonSource();

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

  // Cross-source deduplication. The same physical robot can appear in
  // multiple sections at once: a desktop tray running on this Mac is
  // both on `localhost` AND on HF central; a Wireless on the LAN
  // shows up in BLE AND on central. We dedupe in two passes:
  //
  //   1. By ``install_id`` - the stable, per-install reconciliation
  //      key. Works the moment the central server propagates
  //      ``meta.install_id`` from the daemon's ``setPeerStatus``.
  //   2. Fallback by central ``peerId`` - the relay-assigned id we
  //      get back over the welcome frame, surfaced via
  //      ``/api/daemon/identity`` as ``central_peer_id``. This
  //      handles the current state of the world where the central
  //      server still strips ``meta.install_id``: we may not see the
  //      install_id on the central row, but we *do* know the peerId
  //      central just gave to our own loopback daemon, so we can
  //      filter it out.
  //
  // Older daemons that don't expose either field simply never collide
  // and are shown as-is - forward-compatible and avoids accidentally
  // hiding rows on a partial rollout.
  const dedupedRemote = useMemo<CentralSourceState>(() => {
    if (remote.state.kind === 'no-token') return remote.state;
    const localDaemonReady =
      localDaemon.state.kind === 'ready' ? localDaemon.state.daemon : null;
    const localInstallId = localDaemonReady?.installId ?? null;
    const localCentralPeerId = localDaemonReady?.centralPeerId ?? null;
    if (!localInstallId && !localCentralPeerId) return remote.state;
    const filtered = remote.state.robots.filter((r) => {
      if (localInstallId) {
        const id = extractInstallId(r);
        if (id === localInstallId) return false;
      }
      if (localCentralPeerId) {
        const peerId = extractRobotId(r);
        if (peerId === localCentralPeerId) return false;
      }
      return true;
    });
    if (filtered.length === remote.state.robots.length) return remote.state;
    return { ...remote.state, robots: filtered };
  }, [remote.state, localDaemon.state]);

  const hasAnyRobot =
    localDaemon.state.kind === 'ready' ||
    bleList.length > 0 ||
    (dedupedRemote.kind === 'ready' && dedupedRemote.robots.length > 0) ||
    (dedupedRemote.kind === 'loading' && dedupedRemote.robots.length > 0);

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

        {/* "On this Mac" comes first when present: physically the
            closest of the three sources, and zero-friction (no BLE
            scan, no Wi-Fi onboarding required to land in a session).
            Hidden entirely when no daemon answers on the loopback,
            which is the steady state on mobile builds. */}
        {localDaemon.state.kind === 'ready' ? (
          <LocalDaemonSection
            daemon={localDaemon.state.daemon}
            onPick={onLocalhostPicked}
          />
        ) : null}

        <BluetoothSection
          devices={bleList}
          isScanning={isScanning}
          adapterUnavailable={adapterUnavailable}
          onPick={onRobotPicked}
        />

        <RemoteSection
          username={username}
          state={dedupedRemote}
          onPick={onRemotePicked}
          onSignOut={onSignOutRemote}
          onRefresh={() => void remote.refresh()}
        />
      </Stack>
    </Stack>
  );
}

/* --- Shared card styles --------------------------------------------- */

// Shared visual sx for the three "tap a robot" cards. Hoisted because the
// LocalDaemonCard / BleRobotCard / RemoteRobotCard variants only differ by
// avatar + body content; the chrome (border, hover, padding) must stay in
// sync across the three.
const CARD_BUTTON_SX = {
  p: 2,
  borderRadius: 2,
  bgcolor: 'background.paper',
  border: (theme: import('@mui/material/styles').Theme) =>
    `1px solid ${theme.palette.divider}`,
  '&:hover': {
    bgcolor: 'action.hover',
    borderColor: 'primary.main',
  },
} as const;

// `userSelect: 'text'` overrides MUI ButtonBase's default of `none` so the
// caption (notably the `#xxxxxx` install_id suffix) can be drag-selected
// for copy/paste into a debugging chat. The browser swallows the click
// when the gesture ended in a selection, so the row's onTap stays safe.
const SELECTABLE_TEXT_SX = {
  userSelect: 'text',
  WebkitUserSelect: 'text',
  cursor: 'text',
} as const;

const CARD_TEXT_STACK_SX = {
  flex: 1,
  minWidth: 0,
  ...SELECTABLE_TEXT_SX,
} as const;

/* --- Local daemon section (loopback / tray app) --------------------- */

const DEFAULT_ROBOT_NAME = 'reachy_mini';

function LocalDaemonSection({
  daemon,
  onPick,
}: {
  daemon: LocalDaemonInfo;
  onPick: (daemon: LocalDaemonInfo) => void;
}) {
  // The "needs naming" signal in the row caption is a hint, not a
  // gate: tapping still works. The session screen takes over and
  // forces the naming overlay before bridging when the name is the
  // default, so we simply surface the situation here.
  const isDefaultName = daemon.robotName === DEFAULT_ROBOT_NAME;
  return (
    <Section
      title="Reachy Mini tray (this Mac)"
      subtitle={`Daemon on ${daemon.host} · API rev ${daemon.apiRevision ?? '?'}`}
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
        <LocalDaemonCard
          daemon={daemon}
          isDefaultName={isDefaultName}
          onTap={() => onPick(daemon)}
        />
      </List>
    </Section>
  );
}

function LocalDaemonCard({
  daemon,
  isDefaultName,
  onTap,
}: {
  daemon: LocalDaemonInfo;
  isDefaultName: boolean;
  onTap: () => void;
}) {
  // Short suffix from the install_id so that two unnamed
  // ``reachy_mini`` rows are visually distinguishable in the listing.
  // 6 hex chars give us ~16M of collision space, which is overkill for
  // the "robots on the same desk" cardinality we actually face.
  const idSuffix = daemon.installId ? daemon.installId.slice(0, 6) : null;
  const captionId = idSuffix ? ` · #${idSuffix}` : '';
  const caption = isDefaultName
    ? `Needs a name · USB / loopback${captionId}`
    : `${daemon.robotName} · USB / loopback${captionId}`;
  return (
    <ListItemButton
      onClick={onTap}
      sx={CARD_BUTTON_SX}
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
          <LaptopMacIcon fontSize="small" />
        </Avatar>
        <Stack sx={CARD_TEXT_STACK_SX}>
          <Typography variant="body1" fontWeight={600} noWrap sx={SELECTABLE_TEXT_SX}>
            {isDefaultName ? 'Unnamed Reachy' : daemon.robotName}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            fontFamily="monospace"
            noWrap
            sx={SELECTABLE_TEXT_SX}
          >
            {caption}
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
    <ListItemButton onClick={onTap} sx={CARD_BUTTON_SX}>
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
        <Stack sx={CARD_TEXT_STACK_SX}>
          <Typography variant="body1" fontWeight={600} noWrap sx={SELECTABLE_TEXT_SX}>
            {device.name}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            fontFamily="monospace"
            sx={SELECTABLE_TEXT_SX}
          >
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
  const installId = extractInstallId(robot);
  // Same disambiguation suffix as the local daemon card. We prefer
  // showing the install_id over the central peer_id since it's stable
  // (peer_id rotates on every relay reconnect and would change the
  // visual hash on every reboot).
  const idSuffix = installId
    ? installId.slice(0, 6)
    : id
      ? id.slice(0, 6)
      : null;
  const caption = idSuffix
    ? `#${idSuffix} · Signaling`
    : id
      ? `${id.slice(0, 8)}… · Signaling`
      : 'no peerId';
  return (
    <ListItemButton disabled={disabled} onClick={onTap} sx={CARD_BUTTON_SX}>
      <Stack direction="row" alignItems="center" spacing={2} sx={{ width: '100%' }}>
        <Avatar sx={{ bgcolor: 'secondary.main', width: 40, height: 40 }}>
          <SmartToyIcon fontSize="small" />
        </Avatar>
        <Stack sx={CARD_TEXT_STACK_SX}>
          <Typography variant="body1" fontWeight={600} noWrap sx={SELECTABLE_TEXT_SX}>
            {extractRobotName(robot)}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            fontFamily="monospace"
            noWrap
            sx={SELECTABLE_TEXT_SX}
          >
            {caption}
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
