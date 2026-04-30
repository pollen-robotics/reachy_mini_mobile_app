/**
 * Unified discovery screen.
 *
 * Reached only after the auth gate at the App root, so a HF token is
 * always available here. Three sources feed a single aggregated list
 * of physical robots:
 *
 *   1. **Bluetooth (LAN)**       - BLE-advertised Reachy Minis nearby.
 *      Continuously rescanning so the list stays fresh.
 *   2. **Localhost loopback**    - the desktop tray's daemon answering
 *      on `127.0.0.1:8000`. Always a tray + USB by construction (see
 *      `presence/localDaemonSource.ts` invariants).
 *   3. **HF central**            - robots registered with Hugging Face
 *      central signaling, polled with the gate-issued token.
 *
 * The screen does NOT render the three sources side-by-side anymore.
 * Instead, `aggregateRobots` fuses them into one `AggregatedRobot[]`
 * keyed on `install_id`. Each card represents one **physical robot**.
 *
 * Information hierarchy
 * ─────────────────────
 *   - **Title**: robot's display name.
 *   - **Subtitle**: a single human-readable reachability sentence
 *     ("Connected via USB", "Reachable via Wi-Fi", "Nearby
 *     (Bluetooth)", etc.) coloured by the rolled-up health: green
 *     for ok, amber for degraded, red for error / unreachable.
 *   - The previous chip+dot combo is gone: it duplicated information
 *     and the dot was too discreet to be parsed at a glance.
 *
 * Sign-out lives in the top bar; tapping it clears the token and the
 * App root drops back to the gate.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Avatar,
  Button,
  Chip,
  IconButton,
  List,
  ListItemButton,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import type { Theme } from '@mui/material/styles';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import LaptopMacIcon from '@mui/icons-material/LaptopMac';
import LogoutIcon from '@mui/icons-material/Logout';
import SmartToyIcon from '@mui/icons-material/SmartToy';

import { SCAN_TIMEOUT_MS } from '../ble/constants';
import { useBleSession } from '../ble/useBleSession';
import type { ReachyBleDevice } from '../ble/useBleSession';
import { aggregateRobots } from '../presence/aggregateRobots';
import type {
  AggregatedRobot,
  RobotTransport,
} from '../presence/aggregatedRobot';
import { describeErrorCode } from '../presence/centralEntryPolicy';
import { useCentralSource } from '../presence/centralSource';
import { useLocalDaemonSource } from '../presence/localDaemonSource';
import { FONT_WEIGHT, LAYOUT, TYPO } from '../styles/tokens';

interface ScanScreenProps {
  /**
   * Fired when the user taps a card. The aggregator has already
   * resolved the robot's identity across sources; the parent then
   * runs `pickBestTarget` to derive a `ConnectionTarget`.
   */
  onRobotPicked: (robot: AggregatedRobot) => void;
  onSignOutRemote: () => void;
  /**
   * HF token is guaranteed to be present here (the App-level auth
   * gate renders RemoteSignInScreen otherwise). Forwarded to
   * `useCentralSource` so it can poll the user's fleet.
   */
  token: string;
  username: string | null;
}

/** Re-trigger the scan a beat before it expires so the stream of
 * advertisements never pauses from the user's perspective. */
const SCAN_REFRESH_MS = Math.max(3_000, SCAN_TIMEOUT_MS - 1_000);

export default function ScanScreen({
  onRobotPicked,
  onSignOutRemote,
  token,
  username,
}: ScanScreenProps) {
  const { status, devices, adapterUnavailable, startScanning } = useBleSession();
  const remote = useCentralSource(token);
  const localDaemon = useLocalDaemonSource();

  // Timestamp of the last discovery cycle that the UI should treat as
  // "fresh". Bumped on every auto-rescan (interval below) and on every
  // manual refresh; consumed by `RefreshStatus` to render the
  // "Updated Xs ago" caption that doubles as the tap-to-refresh
  // affordance (Option C: passive freshness indicator instead of an
  // explicit refresh button).
  const [lastRefreshAt, setLastRefreshAt] = useState(() => Date.now());

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void startScanning();
    setLastRefreshAt(Date.now());
    const id = window.setInterval(() => {
      if (adapterUnavailable) return;
      void startScanning({ preserve: true });
      setLastRefreshAt(Date.now());
    }, SCAN_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [startScanning, adapterUnavailable]);

  const isScanning = status === 'scanning';

  // Manual rescan: kicks every source in parallel and bumps the
  // freshness clock so the caption flips back to "just now".
  const refreshAll = useCallback(() => {
    setLastRefreshAt(Date.now());
    if (!adapterUnavailable) {
      void startScanning({ preserve: true });
    }
    void remote.refresh();
    void localDaemon.refresh();
  }, [adapterUnavailable, startScanning, remote, localDaemon]);
  const bleList = useMemo(() => Object.values(devices), [devices]);
  const centralRobots = useMemo(
    () =>
      remote.state.kind === 'no-token' ? [] : remote.state.robots,
    [remote.state],
  );
  const localDaemonInfo = useMemo(
    () =>
      localDaemon.state.kind === 'ready' ? localDaemon.state.daemon : null,
    [localDaemon.state],
  );

  // The single aggregated source of truth for the rendered list.
  // Memoised: every input change refreshes, but identity-equal inputs
  // produce reference-equal output, so React doesn't re-render the
  // list unnecessarily.
  const robots = useMemo(
    () =>
      aggregateRobots({
        bleDevices: bleList,
        centralRobots,
        localDaemon: localDaemonInfo,
      }),
    [bleList, centralRobots, localDaemonInfo],
  );

  // Split visible robots into the "tappable" group and the
  // "unavailable" group (visible but disabled, e.g. backend in
  // error state). Hidden rows (visible=false) are dropped entirely.
  const tappable = robots.filter((r) => r.visible && !r.disabled);
  const unavailable = robots.filter((r) => r.visible && r.disabled);
  const hasAnyTappable = tappable.length > 0;

  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        overflowY: 'auto',
      }}
    >
      {/*
        Two-tier vertical layout:
          - TopBar pinned at the top (in the safe-area zone).
          - The rest of the column (title + list + unavailable group)
            lives in a flex-grow:1 child with `justifyContent:'center'`,
            so when the fleet is small (1-2 robots) the cards float at
            the optical centre of the viewport instead of clinging to
            the top of the screen.
        Both tiers share the same 420 px content column centred via
        `mx:'auto'` so the layout stays anchored on iPad / Mac too.
      */}
      <Stack
        sx={{
          minHeight: '100%',
          width: '100%',
          maxWidth: LAYOUT.contentMaxWidth,
          mx: 'auto',
          px: 3,
          pt: LAYOUT.safeAreaTop,
          pb: 4,
        }}
      >
        <TopBar
          username={username}
          onSignOut={onSignOutRemote}
        />

        <Stack
          spacing={2.5}
          alignItems="center"
          justifyContent="center"
          sx={{
            flex: 1,
            width: '100%',
            // Generous top breathing room so the title isn't kissing
            // the TopBar when the fleet is large enough to fill the
            // screen anyway.
            pt: 4,
          }}
        >
          <Stack alignItems="center" spacing={0.5}>
            <Typography
              sx={{
                fontSize: TYPO.xl,
                fontWeight: FONT_WEIGHT.semibold,
                color: 'text.primary',
                letterSpacing: '-0.2px',
                textAlign: 'center',
              }}
            >
              Choose your Reachy
            </Typography>
            {/* Passive freshness indicator (Option C): doubles as the
                manual-refresh affordance. Replaces both the previous
                "We're scanning..." subtitle and the standalone refresh
                IconButton; one component now communicates both the
                live state and the call-to-action. */}
            <RefreshStatus
              isScanning={isScanning}
              lastRefreshAt={lastRefreshAt}
              onRefresh={refreshAll}
            />
          </Stack>

          {hasAnyTappable ? (
            <RobotList robots={tappable} onTap={onRobotPicked} />
          ) : (
            <EmptyState adapterUnavailable={adapterUnavailable} />
          )}

          {unavailable.length > 0 ? (
            <UnavailableGroup robots={unavailable} />
          ) : null}
        </Stack>
      </Stack>
    </Stack>
  );
}

// ─── Top bar ────────────────────────────────────────────────────────

/**
 * Identity / auth chrome only. The refresh action moved out to
 * `ListToolbar` because it belongs to the discovery domain, not the
 * auth one — keeping it next to "Sign out" was reading as if both
 * were account actions.
 */
function TopBar({
  username,
  onSignOut,
}: {
  username: string | null;
  onSignOut: () => void;
}) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      sx={{ width: '100%', mt: 1 }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
        <Avatar sx={{ width: 28, height: 28, fontSize: TYPO.xs }}>
          {username ? username.slice(0, 1).toUpperCase() : '?'}
        </Avatar>
        <Typography
          sx={{
            fontSize: TYPO.xs,
            color: 'text.secondary',
            fontWeight: FONT_WEIGHT.medium,
          }}
          noWrap
        >
          {username ? `Signed in as ${username}` : 'Signed in'}
        </Typography>
      </Stack>
      <IconButton
        onClick={onSignOut}
        aria-label="Sign out"
        size="small"
        color="default"
      >
        <LogoutIcon fontSize="small" />
      </IconButton>
    </Stack>
  );
}

// ─── Refresh status ─────────────────────────────────────────────────

/**
 * Passive freshness indicator + manual refresh affordance.
 *
 * Replaces the previous `<IconButton>` refresh control and the
 * "We're scanning..." subtitle with a single low-contrast caption
 * sitting under the screen title:
 *
 *   - while a scan is in flight  → "Updating…"
 *   - just after a successful pass → "Updated just now"
 *   - older than ~8s             → "Updated 23s ago"
 *   - older than 60s             → "Updated 1 min ago"
 *
 * The whole caption is tappable and forces a manual rescan. We rely
 * on the auto-refresh interval (`SCAN_REFRESH_MS`) to keep the label
 * fresh in steady state, so the user almost never has to tap; the
 * affordance is there as a fallback when something looks stale.
 *
 * The internal `now` clock is local to this component to avoid
 * triggering top-level re-renders of the whole screen every 5s.
 */
function RefreshStatus({
  isScanning,
  lastRefreshAt,
  onRefresh,
}: {
  isScanning: boolean;
  lastRefreshAt: number;
  onRefresh: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Pause the ticker while a scan is running: the label is locked
    // to "Updating…" anyway, so re-rendering buys us nothing.
    if (isScanning) return;
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, [isScanning]);

  const ageMs = Math.max(0, now - lastRefreshAt);
  const label = isScanning ? 'Updating…' : `Updated ${formatRelativeAge(ageMs)}`;

  return (
    <Button
      variant="text"
      size="small"
      onClick={onRefresh}
      aria-label="Refresh discovery"
      sx={{
        textTransform: 'none',
        color: 'text.secondary',
        fontSize: TYPO.xs,
        fontWeight: FONT_WEIGHT.medium,
        px: 1,
        py: 0.25,
        minHeight: 0,
        opacity: 0.75,
        transition: 'opacity 120ms ease',
        '&:hover': { opacity: 1, bgcolor: 'transparent' },
        '&:focus-visible': { opacity: 1 },
      }}
    >
      {label}
    </Button>
  );
}

/**
 * Render a relative age in the human-friendly compact form used by
 * `RefreshStatus`. Coarse rounding on purpose: the indicator is
 * passive, not a stopwatch, and we don't want the user's eye to be
 * pulled to a number that ticks every second.
 */
function formatRelativeAge(ms: number): string {
  if (ms < 8_000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s ago`;
  const m = Math.round(ms / 60_000);
  return m === 1 ? '1 min ago' : `${m} min ago`;
}

// ─── List ───────────────────────────────────────────────────────────

function RobotList({
  robots,
  onTap,
}: {
  robots: AggregatedRobot[];
  onTap: (r: AggregatedRobot) => void;
}) {
  return (
    <List
      disablePadding
      sx={{
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      {robots.map((robot) => (
        <RobotCard
          key={robot.key}
          robot={robot}
          onTap={() => onTap(robot)}
        />
      ))}
    </List>
  );
}

// ─── Card ───────────────────────────────────────────────────────────

const CARD_BUTTON_SX = {
  p: 2,
  borderRadius: 2,
  bgcolor: 'background.paper',
  border: (theme: Theme) => `1px solid ${theme.palette.divider}`,
  '&:hover': {
    bgcolor: 'action.hover',
    borderColor: 'primary.main',
  },
} as const;

const DISABLED_CARD_SX = {
  ...CARD_BUTTON_SX,
  opacity: 0.6,
  '&:hover': { bgcolor: 'background.paper', borderColor: 'divider' },
} as const;

/**
 * Chip kinds rendered next to the robot name.
 *
 * Each kind maps to a single chip with its own colour scheme. The
 * combination of kinds tells the user what they can actually do with
 * this robot at a glance:
 *
 *   - `usb`        : a wired path is available (Mac tray loopback OR
 *                    a USB-tethered robot on central).
 *   - `wifi`       : the robot is on a Wi-Fi network (only inferable
 *                    from a central listing with wireless_version
 *                    metadata).
 *   - `bluetooth`  : a BLE advert is currently in range.
 *   - `central`    : the robot is registered on Hugging Face central,
 *                    so it can be reached over the Internet via the
 *                    WebRTC signaling tunnel - regardless of which
 *                    network the phone is on.
 *   - `setup`      : amber call-to-action; the robot has only
 *                    advertised over BLE and isn't (yet) on central,
 *                    so its onboarding (Wi-Fi setup, account claim)
 *                    likely isn't finished.
 *   - `error`      : red, only used in the "Unavailable" group; the
 *                    central listing reports a hard failure code.
 */
type ChipKind = 'usb' | 'wifi' | 'bluetooth' | 'central' | 'setup' | 'error';

interface ChipDescriptor {
  kind: ChipKind;
  label: string;
}

/**
 * Decide if a BLE-only row should be surfaced as "Setup pending".
 *
 * Authoritative path: TLV 0x03 ``networkMode`` from the BLE advert.
 *   - ``'connected'`` → setup done (regardless of central status).
 *   - ``'hotspot'`` or ``'offline'`` → setup pending.
 *
 * Fallback path (legacy daemons that don't publish TLV 0x03): treat
 * the absence of ``centralPeerIdPrefix`` as "setup pending". This
 * was the only signal we had before and is good enough for legacy
 * fleets, even though it can flicker when the relay flaps. It will
 * become dead code once every robot in the wild ships with
 * TLV 0x03 support (~weeks after this lands).
 */
function isSetupPending(ble: ReachyBleDevice | null): boolean {
  if (!ble) return false;
  if (ble.networkMode !== null) {
    return ble.networkMode !== 'connected';
  }
  return !ble.centralPeerIdPrefix;
}

/**
 * Pure projection from an `AggregatedRobot` to the chip set rendered
 * on its card. No side effects, no theme lookup; the renderer below
 * maps the `kind` to colours.
 *
 * Deduplication rules:
 *   - "USB" appears at most once even when both localhost AND
 *     central(wireless=false) are present (the previous bug: the
 *     Mac tray would render two USB chips).
 *
 * Setup-pending detection (BLE TLV 0x03 ``network_mode``)
 * ────────────────────────────────────────────────────────
 * The daemon publishes its **local** network mode in the BLE
 * advertisement under TLV tag 0x03. This signal is derived directly
 * from ``ip -4 addr`` on the robot, so it doesn't depend on HF
 * central / Internet / token / registration state - i.e. it doesn't
 * flicker when central is unstable. Values:
 *
 *   - ``'connected'`` → Wi-Fi (or USB tether) is up. Setup done.
 *   - ``'hotspot'``   → wlan0 is on its 10.42.0.1 fallback. Setup
 *                       NOT done (or just lost the network).
 *   - ``'offline'``   → no IPv4 anywhere. Setup pending.
 *   - ``null``        → legacy daemon (TLV not published). We fall
 *                       back to the old heuristic: BLE-only AND no
 *                       ``centralPeerIdPrefix`` advertised.
 *
 * In every case the badge only fires for BLE-only rows: a robot
 * we already see on localhost or central is reachable today, so
 * "Setup pending" would be misleading.
 */
function computeChips(robot: AggregatedRobot): ChipDescriptor[] {
  if (robot.disabled) {
    const reason = robot.errorCode ? describeErrorCode(robot.errorCode) : 'Unavailable';
    return [{ kind: 'error', label: reason }];
  }

  const types = new Set(robot.transports.map((t) => t.type));
  const hasLocal = types.has('localhost');
  const hasBle = types.has('ble');
  const hasCentral = types.has('central');

  if (hasBle && !hasLocal && !hasCentral) {
    const bleTransport = robot.transports.find((t) => t.type === 'ble');
    const ble = bleTransport?.type === 'ble' ? bleTransport.device : null;
    const setupPending = isSetupPending(ble);
    if (setupPending) {
      return [
        { kind: 'setup', label: 'Setup pending' },
        { kind: 'bluetooth', label: 'Bluetooth' },
      ];
    }
    // Has a real network (daemon's local interface is up) but isn't
    // in our HF fleet - most likely owned by another HF user, or
    // just lost the central registration. Surface it as
    // Bluetooth-only so the user can still tap to redo Wi-Fi setup
    // if that's what they want.
    return [{ kind: 'bluetooth', label: 'Bluetooth' }];
  }

  const out: ChipDescriptor[] = [];

  // USB path: surfaced from either source, deduplicated.
  const usbFromLocal = hasLocal;
  const usbFromCentral = hasCentral && robot.wirelessVersion === false;
  if (usbFromLocal || usbFromCentral) {
    out.push({ kind: 'usb', label: 'USB' });
  }

  // Wi-Fi path: only inferable when central knows the wireless flag.
  if (hasCentral && robot.wirelessVersion === true) {
    out.push({ kind: 'wifi', label: 'Wi-Fi' });
  }

  // Local proximity (kept after USB/Wi-Fi so the primary connection
  // path reads first). When BLE coexists with another transport, it
  // is purely a local fallback - useful for re-doing Wi-Fi setup
  // without going through the user's HF account.
  if (hasBle) {
    out.push({ kind: 'bluetooth', label: 'Bluetooth' });
  }

  // Central tag: present whenever the daemon's relay registered with
  // HF central. Independent of how the robot itself is connected
  // (USB tether vs Wi-Fi); it tells the user "we can reach this
  // robot over the Internet", which is the actual transport for
  // every connection that doesn't come from the same Mac.
  if (hasCentral) {
    out.push({ kind: 'central', label: 'Central' });
  }

  return out;
}

interface ChipPalette {
  bg: string;
  fg: string;
  border: string;
}

/** Resolve a chip kind to a concrete colour triplet. */
function chipPalette(theme: Theme, kind: ChipKind): ChipPalette {
  const isDark = theme.palette.mode === 'dark';
  switch (kind) {
    case 'central':
      return {
        bg: isDark
          ? 'rgba(34, 197, 94, 0.18)'
          : 'rgba(34, 197, 94, 0.12)',
        fg: theme.palette.success.dark,
        border: 'rgba(34, 197, 94, 0.35)',
      };
    case 'setup':
      return {
        bg: isDark
          ? 'rgba(245, 158, 11, 0.22)'
          : 'rgba(245, 158, 11, 0.14)',
        fg: theme.palette.warning.dark,
        border: 'rgba(245, 158, 11, 0.4)',
      };
    case 'error':
      return {
        bg: isDark
          ? 'rgba(239, 68, 68, 0.22)'
          : 'rgba(239, 68, 68, 0.12)',
        fg: theme.palette.error.dark,
        border: 'rgba(239, 68, 68, 0.4)',
      };
    case 'usb':
    case 'wifi':
    case 'bluetooth':
    default:
      return {
        bg: theme.palette.action.hover,
        fg: theme.palette.text.primary,
        border: theme.palette.divider,
      };
  }
}

function RobotCard({
  robot,
  onTap,
  disabled = false,
}: {
  robot: AggregatedRobot;
  onTap?: () => void;
  disabled?: boolean;
}) {
  const chips = computeChips(robot);

  return (
    <ListItemButton
      onClick={disabled ? undefined : onTap}
      disabled={disabled}
      sx={disabled ? DISABLED_CARD_SX : CARD_BUTTON_SX}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={2}
        sx={{ width: '100%' }}
      >
        <RobotAvatar robot={robot} disabled={disabled} />
        <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.5}>
          <Typography
            variant="body1"
            fontWeight={FONT_WEIGHT.semibold}
            noWrap
            sx={{ minWidth: 0 }}
          >
            {robot.displayName}
          </Typography>
          {chips.length > 0 ? (
            <Stack
              direction="row"
              spacing={0.5}
              sx={{ flexWrap: 'wrap', rowGap: 0.5, minWidth: 0 }}
            >
              {chips.map((c) => (
                <ChannelChip key={`${c.kind}:${c.label}`} chip={c} />
              ))}
            </Stack>
          ) : null}
        </Stack>
        {!disabled ? <ChevronRightIcon color="action" /> : null}
      </Stack>
    </ListItemButton>
  );
}

/** Single styled chip rendered inside a robot card. */
function ChannelChip({ chip }: { chip: ChipDescriptor }) {
  const theme = useTheme();
  const palette = chipPalette(theme, chip.kind);
  return (
    <Chip
      label={chip.label}
      size="small"
      sx={{
        height: 22,
        fontSize: TYPO.tiny,
        fontWeight: FONT_WEIGHT.semibold,
        backgroundColor: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        '& .MuiChip-label': { px: 0.875 },
      }}
    />
  );
}

function RobotAvatar({
  robot,
  disabled,
}: {
  robot: AggregatedRobot;
  disabled: boolean;
}) {
  const theme = useTheme();
  const isTray = robot.kind === 'tray';
  const bg = disabled
    ? theme.palette.action.disabledBackground
    : isTray
      ? theme.palette.success.main
      : theme.palette.primary.main;
  const fg = disabled
    ? theme.palette.text.disabled
    : isTray
      ? theme.palette.success.contrastText
      : theme.palette.primary.contrastText;
  return (
    <Avatar sx={{ bgcolor: bg, color: fg, width: 40, height: 40 }}>
      {isTray ? <LaptopMacIcon fontSize="small" /> : <SmartToyIcon fontSize="small" />}
    </Avatar>
  );
}

// We don't need to reference the per-transport metadata in the
// rendered card anymore (the reachability text rolls them up), but we
// keep the type alias around so future per-transport breakdown views
// have a typed shape to consume without re-deriving it.
export type RenderedTransport = RobotTransport['type'];

// ─── Empty state ─────────────────────────────────────────────────────

/**
 * Empty / blocked state shown in lieu of the robot list.
 *
 * No spinner anymore: the live scan signal is now carried by the
 * `RefreshStatus` caption sitting above this block ("Updating…" /
 * "Updated 5s ago"), so a second progress indicator would only
 * add visual noise. The `scanning` prop is preserved on the
 * signature for future per-state copy variations even though it is
 * no longer rendered as an animation.
 */
function EmptyState({
  adapterUnavailable,
}: {
  adapterUnavailable: boolean;
}) {
  return (
    <Stack
      alignItems="center"
      spacing={1.5}
      sx={{
        width: '100%',
        py: 4,
        px: 2,
        textAlign: 'center',
      }}
    >
      {adapterUnavailable ? (
        <>
          <Typography variant="body2" color="text.primary">
            Bluetooth is off
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Enable Bluetooth in your device settings to discover nearby
            Reachy Minis.
          </Typography>
        </>
      ) : (
        <>
          <Typography variant="body2" color="text.primary">
            No Reachy yet
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Make sure your Reachy is awake and within range. We'll
            keep scanning.
          </Typography>
        </>
      )}
    </Stack>
  );
}

// ─── Unavailable group ──────────────────────────────────────────────

function UnavailableGroup({ robots }: { robots: AggregatedRobot[] }) {
  return (
    <Stack
      spacing={1}
      sx={{ width: '100%', mt: 2, opacity: 0.95 }}
    >
      <Typography
        sx={{
          fontSize: TYPO.tiny,
          fontWeight: FONT_WEIGHT.semibold,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'text.secondary',
          px: 0.5,
        }}
      >
        Unavailable ({robots.length})
      </Typography>
      <List
        disablePadding
        sx={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        {robots.map((robot) => (
          <RobotCard key={robot.key} robot={robot} disabled />
        ))}
      </List>
    </Stack>
  );
}
