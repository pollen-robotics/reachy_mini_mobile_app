/**
 * SessionTopBar - chrome at the top of the post-discovery screen.
 *
 * Same shape regardless of phase, so the user never sees a layout
 * reflow during bring-up. The right-hand cluster (menu dot vs
 * nothing) toggles inside the component.
 *
 * The top bar deliberately doesn't know about FSM events: the screen
 * passes plain callbacks (`onBack`, `onForgetWifi`, `onDisconnect`)
 * which the controller turns into FSM dispatches. That keeps the
 * component reusable in tests / storybook without dragging the
 * session controller along.
 */
import { useState } from 'react';
import {
  Chip,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import type { Theme } from '@mui/material/styles';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import MoreVertIcon from '@mui/icons-material/MoreVert';

import { FONT_WEIGHT, LAYOUT, TYPO } from '../../styles/tokens';

/**
 * Chip taxonomy used by the top bar.
 *
 * Mirrors `ChipDescriptor` in `ScanScreen.tsx` so the two surfaces
 * read consistently, but kept independent (different shape: status
 * chips on the discovery cards never include motor state). We do
 * NOT import from the scan screen to avoid a circular dependency
 * between the discovery list and the session UI.
 */
type SessionChipKind =
  | 'bluetooth'
  | 'usb'
  | 'central'
  | 'awake'
  | 'sleeping'
  | 'pending';

interface SessionChipDescriptor {
  kind: SessionChipKind;
  label: string;
}

function describeTransport(
  transport: 'BLE' | 'USB' | 'HF',
): SessionChipDescriptor {
  switch (transport) {
    case 'BLE':
      return { kind: 'bluetooth', label: 'Bluetooth' };
    case 'USB':
      return { kind: 'usb', label: 'USB' };
    case 'HF':
      return { kind: 'central', label: 'Central' };
  }
}

function describeStatus(
  motorState: 'awake' | 'sleeping' | 'unknown' | null,
  statusText: string,
): SessionChipDescriptor {
  // Pre-engine: surface the current step label as a neutral pending
  // chip. Once the robot is up the chip flips to a coloured motor
  // state (awake/sleeping) with `statusText` as the label.
  if (motorState === null) {
    return { kind: 'pending', label: statusText };
  }
  if (motorState === 'awake') return { kind: 'awake', label: statusText };
  if (motorState === 'sleeping') return { kind: 'sleeping', label: statusText };
  return { kind: 'pending', label: statusText };
}

interface SessionChipPalette {
  bg: string;
  fg: string;
  border: string;
}

function sessionChipPalette(
  theme: Theme,
  kind: SessionChipKind,
): SessionChipPalette {
  const isDark = theme.palette.mode === 'dark';
  switch (kind) {
    case 'central':
    case 'awake':
      return {
        bg: isDark ? 'rgba(34,197,94,0.18)' : 'rgba(34,197,94,0.12)',
        fg: theme.palette.success.dark,
        border: 'rgba(34,197,94,0.35)',
      };
    case 'sleeping':
      return {
        bg: isDark ? 'rgba(59,130,246,0.18)' : 'rgba(59,130,246,0.10)',
        fg: theme.palette.info.dark,
        border: 'rgba(59,130,246,0.35)',
      };
    case 'pending':
    case 'bluetooth':
    case 'usb':
    default:
      return {
        bg: theme.palette.action.hover,
        fg: theme.palette.text.primary,
        border: theme.palette.divider,
      };
  }
}

function SessionChip({ chip }: { chip: SessionChipDescriptor }) {
  const theme = useTheme();
  const palette = sessionChipPalette(theme, chip.kind);
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
        maxWidth: 220,
      }}
    />
  );
}

export interface SessionTopBarProps {
  robotName: string;
  /** First 6 hex chars of the install_id. Currently unused in the
   * rendered header (the simplified design only carries name + chips
   * to match the discovery list). Kept on the prop list for the
   * menu / future debug surfaces and so we don't churn the
   * controller's return type. */
  installIdSuffix: string | null;
  /** Transport badge: BLE (local LAN, surfaced as "Wi-Fi"), USB
   * (loopback / Mac tray), or HF (over-the-internet via central).
   * Constant for the screen. */
  transport: 'BLE' | 'USB' | 'HF';
  /** Endpoint after the badge (LAN IP, loopback host, peer id).
   * Currently unused; the simplified header collapses transport into
   * a single chip with no endpoint sub-line. Kept on the prop list
   * for the same reason as `installIdSuffix`. */
  endpoint: string;
  /** Phase-aware status word: a step label during handshake/engine,
   * the motor state once the robot is up. Always set. Surfaced as
   * the second chip with a tone derived from `motorState`. */
  statusText: string;
  /** Live motor state. `null` during handshake/engine, non-null once
   * the robot is up. Drives the second chip's tone (and the pulse
   * on the `awake` variant). */
  motorState: 'awake' | 'sleeping' | 'unknown' | null;
  /** Daemon software version (e.g. "1.7.0"). Currently unused in the
   * header (diagnostic info, not user-facing). Kept on the prop
   * list for parity with the controller's return shape. */
  daemonVersion: string | null;
  onBack: () => void;
  /** True only during the 'leaving' phase to prevent double-tap. */
  backDisabled: boolean;
  /** Show the right-hand menu dot. False during handshake/engine. */
  showMenu: boolean;
  /**
   * Show the "Forget Wi-Fi" entry. Should be true only when the
   * connected daemon actually owns a Wi-Fi config (the wireless
   * Reachy variant). Hidden for the USB / Mac-tray case where there
   * is no Wi-Fi to forget.
   */
  showForgetWifi: boolean;
  onForgetWifi: () => void;
  onDisconnect: () => void;
}

export function SessionTopBar({
  robotName,
  transport,
  statusText,
  motorState,
  onBack,
  backDisabled,
  showMenu,
  showForgetWifi,
  onForgetWifi,
  onDisconnect,
}: SessionTopBarProps) {
  const theme = useTheme();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  // Project the transport prop ('BLE' | 'USB' | 'HF') onto a
  // user-facing chip. We surface BLE as "Wi-Fi" because the actual
  // session transport is WebRTC-over-LAN once the BLE handshake is
  // done; calling it "BLE" in the header was confusing (suggesting
  // audio went over Bluetooth, which it never did).
  const transportChip = describeTransport(transport);
  const statusChip = describeStatus(motorState, statusText);

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{
        px: 2,
        py: 1,
        pt: LAYOUT.safeAreaTop,
        borderBottom: `1px solid ${theme.palette.divider}`,
        flexShrink: 0,
        bgcolor: 'background.default',
      }}
    >
      <IconButton
        size="small"
        onClick={onBack}
        disabled={backDisabled}
        aria-label="Back"
      >
        <ArrowBackIcon fontSize="small" />
      </IconButton>
      <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.5}>
        {/* Row 1 — bare robot name. Same scale as the discovery
            list's card title for visual continuity. */}
        <Typography variant="body2" sx={{ fontWeight: FONT_WEIGHT.semibold }} noWrap>
          {robotName}
        </Typography>
        {/* Row 2 — transport + status chips. Same shape and palette
            as the chips on the discovery cards (`ChannelChip` in
            ScanScreen) so the user reads "this is the same kind of
            metadata". */}
        <Stack
          direction="row"
          spacing={0.5}
          sx={{ flexWrap: 'wrap', rowGap: 0.5, minWidth: 0 }}
        >
          <SessionChip chip={transportChip} />
          <SessionChip chip={statusChip} />
        </Stack>
      </Stack>
      {showMenu ? (
        <>
          <IconButton
            size="small"
            onClick={(e) => setMenuAnchor(e.currentTarget)}
            aria-label="More options"
          >
            <MoreVertIcon fontSize="small" />
          </IconButton>
          <Menu
            anchorEl={menuAnchor}
            open={menuAnchor !== null}
            onClose={() => setMenuAnchor(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            slotProps={{ paper: { sx: { minWidth: 240 } } }}
          >
            {showForgetWifi ? (
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  onForgetWifi();
                }}
              >
                <ListItemIcon>
                  <DeleteOutlineIcon fontSize="small" color="warning" />
                </ListItemIcon>
                <ListItemText
                  primary="Forget Wi-Fi"
                  secondary="Reachy will return to setup mode"
                  primaryTypographyProps={{ fontWeight: 600 }}
                  secondaryTypographyProps={{ fontSize: '0.7rem' }}
                />
              </MenuItem>
            ) : null}
            {showForgetWifi ? <Divider /> : null}
            <MenuItem
              onClick={() => {
                setMenuAnchor(null);
                onDisconnect();
              }}
            >
              <ListItemIcon>
                <LinkOffIcon fontSize="small" color="error" />
              </ListItemIcon>
              <ListItemText
                primary="Disconnect from robot"
                primaryTypographyProps={{
                  fontWeight: 600,
                  color: 'error.main',
                }}
              />
            </MenuItem>
          </Menu>
        </>
      ) : null}
    </Stack>
  );
}

