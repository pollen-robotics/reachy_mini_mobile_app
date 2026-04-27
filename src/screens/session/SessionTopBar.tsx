/**
 * SessionTopBar - chrome at the top of the post-discovery screen.
 *
 * Same shape regardless of phase, so the user never sees a layout
 * reflow during bring-up. The right-hand cluster (menu dot vs
 * nothing) toggles inside the component, and the menu itself
 * factors out the LAN-only HF auth row.
 *
 * The top bar deliberately doesn't know about FSM events: the screen
 * passes plain callbacks (`onBack`, `onForgetWifi`, `onDisconnect`)
 * which the controller turns into FSM dispatches. That keeps the
 * component reusable in tests / storybook without dragging the
 * session controller along.
 */
import { useState } from 'react';
import {
  Avatar,
  Box,
  CircularProgress,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Typography,
  keyframes,
  useTheme,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import LoginIcon from '@mui/icons-material/Login';
import LogoutIcon from '@mui/icons-material/Logout';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';

import type { useHfAuth } from '../../auth/useHfAuth';

// Pulsing green dot used to advertise "robot is awake and connected".
// Kept here (rather than in tokens) because no other surface uses it.
const glowKf = keyframes`
  0%, 100% { box-shadow: 0 0 0 0 rgba(46, 204, 113, 0.55); }
  50% { box-shadow: 0 0 0 4px rgba(46, 204, 113, 0); }
`;

export interface SessionTopBarProps {
  robotName: string;
  /** Plain text shown under the robot name. The screen builds it from
   * `bleNetworkIp || deviceName || username`. */
  subtitle: string;
  onBack: () => void;
  /** True only during the 'leaving' phase to prevent double-tap. */
  backDisabled: boolean;
  /** Show the right-hand menu dot. False during handshake/engine. */
  showMenu: boolean;
  isLocal: boolean;
  onForgetWifi: () => void;
  onDisconnect: () => void;
  /** Open the long-term memory inspection dialog. */
  onOpenMemory: () => void;
  /** Used by the LAN-only HF auth menu row. Ignored when isLocal is false. */
  auth: ReturnType<typeof useHfAuth>;
}

export function SessionTopBar({
  robotName,
  subtitle,
  onBack,
  backDisabled,
  showMenu,
  isLocal,
  onForgetWifi,
  onDisconnect,
  onOpenMemory,
  auth,
}: SessionTopBarProps) {
  const theme = useTheme();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.25}
      sx={{
        px: 2,
        py: 1,
        pt: 5.5,
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
      <Box
        sx={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          bgcolor: showMenu ? 'success.main' : 'text.disabled',
          animation: showMenu ? `${glowKf} 2s infinite` : 'none',
          flexShrink: 0,
        }}
      />
      <Stack sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
          {robotName}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          fontFamily="monospace"
          noWrap
        >
          {subtitle}
        </Typography>
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
            {isLocal ? (
              <HfAuthMenuItem
                auth={auth}
                onDone={() => setMenuAnchor(null)}
              />
            ) : null}
            {isLocal ? <Divider /> : null}
            <MenuItem
              onClick={() => {
                setMenuAnchor(null);
                onOpenMemory();
              }}
            >
              <ListItemIcon>
                <PsychologyOutlinedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText
                primary="Memory"
                secondary="Inspect what Reachy remembers"
                primaryTypographyProps={{ fontWeight: 600 }}
                secondaryTypographyProps={{ fontSize: '0.7rem' }}
              />
            </MenuItem>
            <Divider />
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
                secondary="Robot will reopen its hotspot"
                primaryTypographyProps={{ fontWeight: 600 }}
                secondaryTypographyProps={{ fontSize: '0.7rem' }}
              />
            </MenuItem>
            <Divider />
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

/**
 * LAN-only menu row: Sign in / out of HF on the daemon side.
 *
 * Why this lives only in LAN mode
 * ───────────────────────────────
 * Remote sessions already pass through `RemoteSignInScreen` at the
 * app gate, so the daemon transparently uses that same token. In
 * LAN we still surface the menu because the daemon has its own HF
 * token store that can drift from the gate token (revoked, scope
 * change, factory reset…) and the user needs a one-tap recovery
 * path that isn't a full screen takeover.
 */
function HfAuthMenuItem({
  auth,
  onDone,
}: {
  auth: ReturnType<typeof useHfAuth>;
  onDone: () => void;
}) {
  const { isAuthenticated, username, avatarUrl, isWaitingForAuth, isLoading } =
    auth;

  if (isAuthenticated) {
    return (
      <MenuItem
        onClick={() => {
          void auth.logout();
          onDone();
        }}
      >
        <ListItemIcon>
          <Avatar
            src={avatarUrl ?? undefined}
            sx={{ width: 26, height: 26, fontSize: 12 }}
          >
            {username?.[0]?.toUpperCase() ?? '?'}
          </Avatar>
        </ListItemIcon>
        <ListItemText
          primary={username ?? 'Hugging Face'}
          secondary="Sign out"
          primaryTypographyProps={{ fontWeight: 600 }}
          secondaryTypographyProps={{ fontSize: '0.7rem' }}
        />
        <LogoutIcon fontSize="small" color="action" sx={{ ml: 1 }} />
      </MenuItem>
    );
  }

  const busy = isLoading || isWaitingForAuth;

  return (
    <MenuItem
      disabled={busy}
      onClick={() => {
        void auth.login();
        onDone();
      }}
    >
      <ListItemIcon>
        {busy ? <CircularProgress size={16} /> : <LoginIcon fontSize="small" />}
      </ListItemIcon>
      <ListItemText
        primary={busy ? 'Waiting for login…' : 'Sign in with Hugging Face'}
        secondary={busy ? 'Finish in your browser' : 'Needed to start a conversation'}
        primaryTypographyProps={{ fontWeight: 600 }}
        secondaryTypographyProps={{ fontSize: '0.7rem' }}
      />
    </MenuItem>
  );
}
