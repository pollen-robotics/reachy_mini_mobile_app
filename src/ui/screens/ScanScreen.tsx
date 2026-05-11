/**
 * Unified discovery screen.
 *
 * Reached only after the auth gate at the App root, so a HF token
 * is always available here. Renders the user's robots that have
 * registered with Hugging Face central signaling (polled with the
 * gate-issued token).
 *
 * Layout (Option C - "compte en haut, robots au centre")
 * ──────────────────────────────────────────────────────
 *   ┌──────────────────────────────────────────┐
 *   │  ◉ tfrere                          [⎋]   │  ← HfAccountBar (top)
 *   │  ----------------------------------------│
 *   │                                          │
 *   │              ╭──╮                        │
 *   │             (·_·)    ← reachy-buste     │
 *   │             /│  │\      hero illu        │
 *   │                                          │
 *   │            Your Reachies                 │
 *   │       N online · tap to connect          │
 *   │                                          │
 *   │   ┌────────────────────────────────┐     │
 *   │   │ [reachy]  ● Name               │     │
 *   │   │           Wi-Fi  · #ab12    >  │     │
 *   │   └────────────────────────────────┘     │   ← scrollable
 *   │   ┌────────────────────────────────┐     │
 *   │   │ [reachy]  ● Other              │     │
 *   │   │           Wi-Fi  · #cd34    >  │     │
 *   │   └────────────────────────────────┘     │
 *   │                                          │
 *   │  ────────────────────────────────────────│
 *   │              ↻ Refresh                   │  ← sticky bottom bar
 *   └──────────────────────────────────────────┘
 *
 *   - HF account bar: physically separated from the robot list
 *     (top of viewport, divider underneath) so the sign-out
 *     gesture is unambiguous and never confused with "disconnect
 *     from this robot".
 *   - Hero illustration: the reachy-buste from the splash, 95%
 *     opaque, gives the screen a brand identity beyond the cards.
 *   - Refresh: pinned at the bottom (with safe-area inset), out
 *     of the scrollable area so it's always one tap away
 *     regardless of how many robots are listed.
 *   - Empty / error states: the list area collapses to a
 *     centred message + retry CTA (the hero illu still sits at
 *     the top and the sticky refresh stays accessible).
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

import { useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  CircularProgress,
  IconButton,
  keyframes,
  List,
  ListItemButton,
  Stack,
  Tooltip,
  Typography,
  alpha,
} from '@mui/material';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import LockIcon from '@mui/icons-material/Lock';
import LogoutIcon from '@mui/icons-material/Logout';
import RefreshIcon from '@mui/icons-material/Refresh';

import type { ReachyBleDevice } from '@/features/ble/useBleSession';
import reachyBusteSvg from '@/assets/reachy-buste.svg';
import RobotAvatar from '@/ui/design/RobotAvatar';
import {
  extractRobotActiveApp,
  extractRobotBusy,
  extractRobotHardwareId,
  extractRobotId,
  extractRobotName,
  extractRobotTransport,
  type CentralRobotEntry,
} from '@/features/auth/fetchRobotsFromCentral';
import { useHfProfile } from '@/features/auth/useHfProfile';
import { useRemoteRobots } from '@/features/auth/useRemoteRobots';
import { TransportChip } from '@/ui/design/TransportChip';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';

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
  // Poll cadence is the safety net for the SSE listener now that
  // central pushes busy/free transitions in real time. Letting the
  // hook own the default keeps the cadence consistent across the
  // whole app.
  const remote = useRemoteRobots(token);
  // Pull the avatar URL (and a freshly-confirmed username) from
  // /api/whoami-v2. Falls back gracefully to the gate-issued
  // username + initial-letter avatar while the request is in
  // flight or if it fails - the top bar always renders.
  const profile = useHfProfile(token);
  const displayName = profile.username ?? username;
  const robots = remote.state.kind !== 'no-token' ? remote.state.robots : [];
  const hasRobots = robots.length > 0;
  // Distinguish the very first fetch (no cached data yet, the body
  // shows a spinner) from any subsequent refresh / poll (cached data
  // is still on screen, only the refresh icon should hint at the
  // in-flight request).
  const isInitialLoading =
    remote.state.kind === 'loading' && robots.length === 0;
  const isRefreshing =
    remote.state.kind === 'loading' && robots.length > 0;
  // Keep the refresh bar mounted whenever we've moved past the very
  // first load, so the layout never shifts under the user. The button
  // itself disables + spins during in-flight fetches instead.
  const showRefreshBar = !isInitialLoading;

  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        bgcolor: 'background.default',
      }}
    >
      <HfAccountBar
        username={displayName}
        avatarUrl={profile.avatarUrl}
        onSignOut={onSignOutRemote}
      />

      {/* Inner scroll container. `m: 'auto'` on the column distributes
          free space equally on all four sides → fully centred (both
          axes) when the cards fit within the viewport, and falls back
          to top-aligned scrolling when they don't (the `auto` margins
          collapse to zero once the content overflows, and the parent's
          `overflowY` then takes over). */}
      <Stack
        sx={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          overflowY: 'auto',
        }}
      >
        <Stack
          spacing={3}
          sx={{
            m: 'auto',
            width: '100%',
            maxWidth: LAYOUT.contentMaxWidth,
            px: 3,
            py: 4,
          }}
        >
          <Stack alignItems="center" spacing={2}>
            <HeroBuste />
            <RobotsHeader
              state={remote.state.kind}
              count={robots.length}
              hasRobots={hasRobots}
            />
          </Stack>

          {hasRobots ? (
            <List
              disablePadding
              sx={{
                width: '100%',
                display: 'flex',
                flexDirection: 'column',
                // Doubled from the previous 1.25 (10 px) to give
                // each Reachy card more breathing room - the
                // earlier tighter rhythm made the list read as a
                // dense settings menu rather than a small fleet
                // of distinct devices.
                gap: 2.5,
              }}
            >
              {robots.map((robot: CentralRobotEntry) => {
                const id = extractRobotId(robot);
                // Gate the tap on `busy` as well as `!id`: a busy
                // robot would just round-trip to a `sessionRejected`
                // error after the user spent ~3 s on the connecting
                // overlay. Surfacing it BEFORE the tap is a better
                // user experience than reactively explaining the
                // failure. Pre-feature centrals don't emit `busy`,
                // so `extractRobotBusy()` defaults to `false` and
                // the row stays tappable on legacy deploys.
                const busy = extractRobotBusy(robot);
                return (
                  <RemoteRobotCard
                    key={id ?? Math.random()}
                    robot={robot}
                    disabled={!id || busy}
                    onTap={() => onRemotePicked(robot)}
                  />
                );
              })}
            </List>
          ) : remote.state.kind === 'loading' ? (
            <LoadingState />
          ) : remote.state.kind === 'error' ? (
            <CenteredMessageState
              title="Couldn't reach Hugging Face"
              subtitle={remote.state.reason}
            />
          ) : (
            <CenteredMessageState
              title="No Reachy online"
              subtitle="Power one on and connect it to Wi-Fi - it'll show up here."
            />
          )}
        </Stack>
      </Stack>

      {/* Sticky bottom action bar. Sits outside the scrollable area
          so the refresh stays one tap away regardless of how many
          robots are listed. Mounted from the moment we have cached
          data (or an error to retry from) so the layout never shifts
          under the user during a refresh - the button just spins +
          disables in place. Only the very first load hides it
          entirely (the body shows its own loading state). */}
      {showRefreshBar ? (
        <StickyRefreshBar
          onRefresh={() => void remote.refresh()}
          isRefreshing={isRefreshing}
        />
      ) : null}
    </Stack>
  );
}

/* --- HF account top bar --------------------------------------------- */

function HfAccountBar({
  username,
  avatarUrl,
  onSignOut,
}: {
  username: string | null;
  avatarUrl: string | null;
  onSignOut: () => void;
}) {
  // First letter of the username for the fallback avatar (used
  // while the whoami-v2 request is in flight, when the user has
  // no profile picture set, or if the avatar URL fails to load).
  const initial = (username ?? '').slice(0, 1).toUpperCase() || null;
  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      sx={{
        width: '100%',
        pt: `calc(${LAYOUT.safeAreaTop} + 12px)`,
        pb: 1.5,
        px: 2.5,
        bgcolor: 'background.default',
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={{ minWidth: 0, flex: 1 }}
      >
        <Avatar
          src={avatarUrl ?? undefined}
          alt={username ?? 'Hugging Face user'}
          sx={{
            width: 38,
            height: 38,
            flexShrink: 0,
            fontSize: TYPO.body,
            fontWeight: FONT_WEIGHT.semibold,
            bgcolor: theme =>
              theme.palette.mode === 'dark'
                ? 'rgba(255,255,255,0.08)'
                : 'rgba(0,0,0,0.06)',
            color: 'text.secondary',
            border: theme => `1px solid ${theme.palette.divider}`,
          }}
        >
          {initial ?? (
            <AccountCircleIcon
              sx={{ color: 'text.secondary', fontSize: 28 }}
            />
          )}
        </Avatar>
        <Stack sx={{ minWidth: 0 }} spacing={0.25}>
          <Typography
            sx={{
              fontSize: TYPO.md,
              fontWeight: FONT_WEIGHT.semibold,
              color: 'text.primary',
              lineHeight: 1.2,
            }}
            noWrap
          >
            {username ?? 'Hugging Face'}
          </Typography>
          <Typography
            sx={{
              fontSize: TYPO.xs,
              color: 'text.secondary',
              lineHeight: 1.2,
            }}
            noWrap
          >
            Signed in via Hugging Face
          </Typography>
        </Stack>
      </Stack>
      <Tooltip title="Sign out">
        <IconButton
          aria-label="Sign out of Hugging Face"
          onClick={onSignOut}
          color="primary"
          sx={{ p: 1 }}
        >
          <LogoutIcon sx={{ fontSize: 22 }} />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

/* --- Hero illustration (reachy-buste) ------------------------------- */

/**
 * Branded hero displayed above the title.
 *
 * Uses the same `reachy-buste` SVG as the splash, sized down to
 * 120px so it never dominates the cards underneath. Static
 * (no float animation) - the screen is a destination, not a
 * loading transition.
 */
function HeroBuste() {
  return (
    <Box
      sx={{
        width: 144,
        height: 144,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <img
        src={reachyBusteSvg}
        alt=""
        aria-hidden
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      />
    </Box>
  );
}

/* --- Sticky bottom refresh bar -------------------------------------- */

/**
 * Combined rotate + breathe so the icon feels alive instead of
 * mechanical. Subtle scale-down at mid-rotation gives an organic
 * "pulse" reminiscent of physical hardware activity LEDs. Paired
 * with a cubic-bezier ease-in-out so the motion accelerates out of
 * each rotation and decelerates into the next, breaking the
 * uncanny perfect-linear loop.
 */
const refreshSpinKeyframes = keyframes`
  0% {
    transform: rotate(0deg) scale(1);
  }
  50% {
    transform: rotate(180deg) scale(0.92);
  }
  100% {
    transform: rotate(360deg) scale(1);
  }
`;

/**
 * One-shot "wind-up + spin" played on tap. The icon rotates
 * backwards a hair (the wind-up) before completing a full
 * forward rotation, mimicking a physical refresh control. We
 * key it with a remount counter so a second tap immediately
 * replays the animation even if the previous one is still
 * playing.
 */
const refreshTapKeyframes = keyframes`
  0% {
    transform: rotate(0deg) scale(1);
  }
  12% {
    transform: rotate(-32deg) scale(0.94);
  }
  100% {
    transform: rotate(360deg) scale(1);
  }
`;

function StickyRefreshBar({
  onRefresh,
  isRefreshing,
}: {
  onRefresh: () => void;
  isRefreshing: boolean;
}) {
  // Bumped on every tap so the wind-up animation re-plays cleanly
  // even when the user spam-taps. React keys the icon on this
  // counter, so a remount restarts the keyframe from frame 0
  // without us having to reach into the DOM to restart the
  // animation manually.
  const [tapCounter, setTapCounter] = useState(0);

  const handleClick = () => {
    setTapCounter(c => c + 1);
    onRefresh();
  };

  // While a fetch is in flight: the loop animation owns the icon.
  // Otherwise: the wind-up animation plays once per tap, then
  // settles back to its rest position.
  const iconAnimation = isRefreshing
    ? `${refreshSpinKeyframes} 1.1s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite`
    : tapCounter > 0
      ? `${refreshTapKeyframes} 0.55s cubic-bezier(0.34, 1.56, 0.64, 1)`
      : 'none';

  return (
    <Stack
      alignItems="center"
      sx={{
        width: '100%',
        flexShrink: 0,
        pt: 1.5,
        pb: `calc(${LAYOUT.safeAreaBottom} + 12px)`,
        px: 2,
        bgcolor: 'background.default',
      }}
    >
      <Button
        variant="text"
        color="primary"
        disabled={isRefreshing}
        startIcon={
          <RefreshIcon
            // Re-keying on the tap counter forces a remount, which
            // restarts the keyframe animation from frame 0. Cheap
            // way to retrigger CSS animations in React.
            key={`refresh-icon-${tapCounter}-${isRefreshing}`}
            sx={{
              fontSize: 22,
              transformOrigin: 'center',
              animation: iconAnimation,
              // Inherit the button's `color` so icon + label always
              // sit at the same hue (primary at rest, primary +
              // tinted bg while refreshing, primary while disabled).
              color: 'inherit',
            }}
          />
        }
        onClick={handleClick}
        sx={{
          textTransform: 'none',
          fontSize: TYPO.md,
          fontWeight: FONT_WEIGHT.semibold,
          borderRadius: 999,
          px: 3,
          py: 1,
          transition: theme =>
            theme.transitions.create(['background-color', 'color'], {
              duration: theme.transitions.duration.short,
            }),
          // While refreshing: faintly tint the bg so the active
          // state reads at a glance (icon spin + bg + colour all
          // pointing at "something is happening"). The colour is
          // already primary via the `color="primary"` prop.
          ...(isRefreshing && {
            bgcolor: theme => alpha(theme.palette.primary.main, 0.08),
          }),
          // Disabled is just our way to block double-fires - keep
          // the look identical to the active refreshing state
          // (primary colour, full opacity, tinted bg).
          '&.Mui-disabled': {
            color: 'primary.main',
            opacity: 1,
          },
        }}
      >
        Refresh
      </Button>
    </Stack>
  );
}

/* --- Section header (title + live count) ---------------------------- */

function RobotsHeader({
  state,
  count,
  hasRobots,
}: {
  state: ReturnType<typeof useRemoteRobots>['state']['kind'];
  count: number;
  hasRobots: boolean;
}) {
  const subtitle = (() => {
    if (!hasRobots && state === 'loading') return 'Looking for your Reachies…';
    if (!hasRobots && state === 'error') return 'Connection lost - retrying';
    if (!hasRobots) return 'None linked to your Hugging Face account are online';
    if (count === 1) return '1 online · linked to your Hugging Face account';
    return `${count} online · linked to your Hugging Face account`;
  })();

  return (
    <Stack alignItems="center" spacing={0.5} sx={{ width: '100%' }}>
      <Typography
        component="h1"
        sx={{
          m: 0,
          textAlign: 'center',
          fontSize: TYPO.display,
          fontWeight: FONT_WEIGHT.semibold,
          color: 'text.primary',
          letterSpacing: '-0.3px',
        }}
      >
        Your Reachies
      </Typography>
      <Typography
        sx={{
          fontSize: TYPO.sm,
          color: 'text.secondary',
          textAlign: 'center',
        }}
      >
        {subtitle}
      </Typography>
    </Stack>
  );
}

/* --- Robot card ----------------------------------------------------- */

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
  const idTag = (hardwareId ?? id ?? '').slice(0, 5);
  const idLabel = idTag ? `#${idTag}` : '—';
  // Central reports an active session in flight on this producer.
  // We gate `disabled` on this from the parent and surface the
  // state on-card here so the user knows BEFORE tapping that the
  // session would be rejected. `activeApp` is best-effort and may
  // be null if the consumer never advertised a meta.name.
  const busy = extractRobotBusy(robot);
  const activeApp = extractRobotActiveApp(robot);

  return (
    <ListItemButton
      disabled={disabled}
      onClick={onTap}
      sx={{
        p: 2,
        pr: 2.5,
        borderRadius: '14px',
        bgcolor: 'background.paper',
        // Light, neutral border + soft shadow. The card reads as a
        // discreet container; the call-to-action signal moves to
        // the trailing primary-coloured chevron, which is what
        // mobile users actually scan when looking for "tap here to
        // enter". Earlier saturated-primary border made every card
        // shout for attention even before the user picked one.
        border: theme => `1px solid ${theme.palette.divider}`,
        boxShadow: theme =>
          theme.palette.mode === 'dark'
            ? '0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 6px rgba(0,0,0,0.35)'
            : '0 1px 0 rgba(255,255,255,0.6) inset, 0 1px 2px rgba(15,23,42,0.04), 0 2px 6px rgba(15,23,42,0.05)',
        transition: theme =>
          theme.transitions.create(['transform'], {
            duration: theme.transitions.duration.shortest,
          }),
        // No hover override: mobile-first; the press feedback
        // (`scale(0.99)` on `:active`) is what users expect.
        '&:hover': {
          bgcolor: 'background.paper',
        },
        '&:active': {
          transform: 'scale(0.99)',
        },
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={2}
        sx={{ width: '100%' }}
      >
        <CardAvatar />
        {/* Two-row identity grid, both rows left-aligned hugging
            the avatar. Mirrors the post-connect `<IdentityChipBar>`
            so a user who picked a robot keeps recognising the same
            visual taxonomy in the toolbar afterwards. The version
            cell from the toolbar is omitted here: we don't have a
            DataChannel before the user picks the robot, so
            `daemonVersion` is always unknown at this stage. */}
        <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.25}>
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ minWidth: 0 }}
          >
            <Typography
              sx={{
                minWidth: 0,
                fontSize: TYPO.lg,
                fontWeight: FONT_WEIGHT.bold,
                color: 'text.primary',
                letterSpacing: '-0.1px',
                lineHeight: 1.2,
                flexShrink: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              noWrap
            >
              {extractRobotName(robot)}
            </Typography>
            <Box sx={{ flexShrink: 0 }}>
              <TransportChip transport={transport} height={20} />
            </Box>
          </Stack>
          <Typography
            component="span"
            title="Hardware id"
            sx={{
              fontSize: TYPO.xs,
              fontFamily: 'monospace',
              color: theme =>
                theme.palette.mode === 'dark'
                  ? 'rgba(255,255,255,0.40)'
                  : 'rgba(0,0,0,0.36)',
              whiteSpace: 'nowrap',
            }}
          >
            {idLabel}
          </Typography>
        </Stack>
        {/* Trailing affordance: chevron when the row is tappable,
            lock when the robot already has an active session on the
            central. The icon swap is the *only* on-card busy signal -
            no extra row, no chip - so the layout stays calm and the
            disabled fade carries the rest of the meaning. The lock
            tooltip surfaces `activeApp` when the consumer
            advertised a meta.name, so a curious user can still read
            "who's holding it" without us blowing up the card height
            with a chip. */}
        {busy ? (
          <Tooltip
            title={activeApp ? `In use · ${activeApp}` : 'In use'}
            placement="left"
          >
            <LockIcon
              aria-label={
                activeApp ? `In use - ${activeApp}` : 'In use'
              }
              sx={{
                color: 'text.disabled',
                flexShrink: 0,
                fontSize: 20,
              }}
            />
          </Tooltip>
        ) : (
          <ChevronRightIcon
            sx={{
              color: 'primary.main',
              flexShrink: 0,
              fontSize: 22,
            }}
          />
        )}
      </Stack>
    </ListItemButton>
  );
}

/**
 * Card-sized variant of the shared `RobotAvatar`. Kept as a thin
 * wrapper to preserve the original call sites (`<CardAvatar />`)
 * and pin the discovery-card sizing in one place.
 */
function CardAvatar() {
  return <RobotAvatar size={72} />;
}

/* --- States: loading / empty / error ---------------------------------- */

function LoadingState() {
  return (
    <Stack
      alignItems="center"
      spacing={1.5}
      sx={{
        py: 4,
        color: 'text.secondary',
      }}
    >
      <CircularProgress size={24} sx={{ color: 'text.secondary' }} />
      <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium }}>
        Asking Hugging Face for your robots…
      </Typography>
    </Stack>
  );
}

/**
 * Empty / error state rendered as a card.
 *
 * Visually matches the robot cards (same border, radius, soft
 * shadow) so the empty state slots into the same grid instead of
 * floating as a bare paragraph. Content is centred horizontally
 * inside the card; vertical centring on the screen is owned by
 * the outer scroll container's `m: 'auto'` trick.
 */
function CenteredMessageState({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <Box
      sx={{
        width: '100%',
        py: 4,
        px: 3,
        borderRadius: '14px',
        bgcolor: 'background.paper',
        border: theme =>
          `1px solid ${
            theme.palette.mode === 'dark'
              ? 'rgba(255,255,255,0.10)'
              : 'rgba(0,0,0,0.06)'
          }`,
        boxShadow: theme =>
          theme.palette.mode === 'dark'
            ? '0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 6px rgba(0,0,0,0.35)'
            : '0 1px 0 rgba(255,255,255,0.6) inset, 0 1px 2px rgba(15,23,42,0.04), 0 2px 6px rgba(15,23,42,0.05)',
      }}
    >
      <Stack
        alignItems="center"
        spacing={0.75}
        sx={{
          textAlign: 'center',
          maxWidth: 280,
          mx: 'auto',
        }}
      >
        <Typography
          sx={{
            fontSize: TYPO.lg,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.primary',
          }}
        >
          {title}
        </Typography>
        {subtitle ? (
          <Typography
            sx={{
              fontSize: TYPO.sm,
              color: 'text.secondary',
              lineHeight: 1.5,
            }}
          >
            {subtitle}
          </Typography>
        ) : null}
      </Stack>
    </Box>
  );
}
