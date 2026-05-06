/**
 * Unified discovery screen.
 *
 * Reached only after the auth gate at the App root, so a HF token
 * is always available here. Renders the user's robots that have
 * registered with Hugging Face central signaling (polled with the
 * gate-issued token).
 *
 * UX rules:
 *   - The remote section keeps its previous list visible across
 *     polls / refreshes, so the layout never flashes empty.
 *   - Tapping a robot routes to the unified `RobotSessionScreen`,
 *     which owns the connection stepper, motor wake/sleep, and
 *     post-connect chrome.
 *   - Sign-out lives in the remote section header; tapping it
 *     clears the token and the App root drops back to the gate.
 *
 * Parked surfaces
 * ───────────────
 * Earlier revisions also exposed a "Local USB" section (loopback
 * daemon probe) and a "Bluetooth (LAN)" section (BLE rescan).
 * They are intentionally NOT rendered in the mobile shell right
 * now - the focus is the Central listing path. The Wi-Fi setup
 * flow downstream (`WifiSetupScreen`) and its `onRobotPicked`
 * prop on this screen are kept wired so the BLE section can be
 * restored without churning the parent contract.
 */

import {
  Avatar,
  Button,
  CircularProgress,
  IconButton,
  List,
  ListItemButton,
  Stack,
  Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import LogoutIcon from '@mui/icons-material/Logout';
import RefreshIcon from '@mui/icons-material/Refresh';
import SmartToyIcon from '@mui/icons-material/SmartToy';

import type { ReachyBleDevice } from '../ble/useBleSession';
import {
  extractRobotHardwareId,
  extractRobotId,
  extractRobotName,
  extractRobotTransport,
  type CentralRobotEntry,
} from '../auth/fetchRobotsFromCentral';
import { useRemoteRobots } from '../auth/useRemoteRobots';
import { ShortId } from '../components/ShortId';
import { TransportChip } from '../components/TransportChip';
import { FONT_WEIGHT, LAYOUT, TYPO } from '../styles/tokens';

interface ScanScreenProps {
  /**
   * Wired but unused right now: the BLE picker section is parked.
   * Restoring it means rendering a `BluetoothSection` in this file
   * and calling this callback when the user taps a row - no change
   * needed in the parent.
   */
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

export default function ScanScreen({
  onRobotPicked: _onRobotPicked,
  onRemotePicked,
  onSignOutRemote,
  token,
  username,
}: ScanScreenProps) {
  const remote = useRemoteRobots(token, { pollMs: 30_000 });

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
