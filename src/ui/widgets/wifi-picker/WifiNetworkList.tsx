/**
 * Pick-a-network list for putting a robot on Wi-Fi over Bluetooth.
 *
 * Collapsed, each network is a tappable row; tapping one expands an inline
 * password field + Connect button (accordion, one row open at a time), so the
 * whole "choose network → enter password" flow stays in one step. The network
 * the robot is already on gets a "Connected" row with no password; networks
 * saved on the robot get a "Saved" chip and can connect with the password
 * left empty (the robot reuses the one it has).
 *
 * Two consumers: the setup wizard's Wi-Fi step and the Bluetooth tools'
 * "Change Wi-Fi network" flow.
 */
import { useId, useState } from 'react';
import {
  Box,
  Button,
  Collapse,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  Stack,
  TextField,
  Typography,
  alpha,
  type Theme,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import WifiIcon from '@mui/icons-material/Wifi';
import WifiLockIcon from '@mui/icons-material/WifiLock';

import { FONT_WEIGHT, RADIUS, STATUS, TYPO } from '@/ui/design/tokens';

export interface WifiNetworkListProps {
  networks: string[];
  /** SSID the robot is CONFIRMED connected to (null when none). */
  currentSsid: string | null;
  /** Networks saved on the robot: connecting with an empty password reuses
   *  the saved one. */
  saved?: string[];
  /** Tap on the connected row. Omitted → the row is informational only. */
  onKeepCurrent?: () => void;
  /** A row was expanded (the wizard records it for its retry path). */
  onSelect?: (ssid: string) => void;
  onConnect: (password: string, ssid: string) => void;
}

export function WifiNetworkList({
  networks,
  currentSsid,
  saved = [],
  onKeepCurrent,
  onSelect,
  onConnect,
}: WifiNetworkListProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const toggle = (ssid: string) => {
    setExpanded(prev => {
      const next = prev === ssid ? null : ssid;
      if (next) onSelect?.(next);
      return next;
    });
  };

  return (
    <List disablePadding sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1 }}>
      {networks.map(ssid =>
        ssid === currentSsid ? (
          <ConnectedNetworkRow key={ssid} ssid={ssid} onContinue={onKeepCurrent} />
        ) : (
          <WifiNetworkRow
            key={ssid}
            ssid={ssid}
            saved={saved.includes(ssid)}
            expanded={expanded === ssid}
            onToggle={() => toggle(ssid)}
            onConnect={password => onConnect(password, ssid)}
          />
        ),
      )}
    </List>
  );
}

/**
 * Shared "paper card" surface for the selectable rows: an elevated
 * `background.paper` fill + a divider border that emphasises to primary when
 * the row is active (expanded).
 */
function paperCardSx(active: boolean) {
  return {
    bgcolor: 'background.paper',
    borderRadius: `${RADIUS.lg}px`,
    border: (theme: Theme) =>
      `1px solid ${active ? alpha(theme.palette.primary.main, 0.5) : theme.palette.divider}`,
  };
}

/** Small status pill. `color` defaults to the theme's secondary text. */
function Chip({ label, color }: { label: string; color?: string }) {
  return (
    <Typography
      component="span"
      sx={theme => {
        const c = color ?? theme.palette.text.secondary;
        return {
          px: 1,
          py: 0.25,
          borderRadius: `${RADIUS.sm}px`,
          bgcolor: alpha(c, 0.12),
          color: c,
          fontSize: TYPO.xs,
          fontWeight: FONT_WEIGHT.semibold,
          flexShrink: 0,
        };
      }}
    >
      {label}
    </Typography>
  );
}

/** Row for the network the robot is already on: no password accordion. */
function ConnectedNetworkRow({ ssid, onContinue }: { ssid: string; onContinue?: () => void }) {
  const content = (
    <Stack direction="row" spacing={1.75} sx={{ alignItems: 'center', width: '100%' }}>
      <WifiIcon sx={{ color: STATUS.success, fontSize: 22 }} />
      <Typography sx={{ flex: 1, minWidth: 0, fontSize: TYPO.md, fontWeight: FONT_WEIGHT.semibold }} noWrap>
        {ssid}
      </Typography>
      <Chip label="Connected" color={STATUS.success} />
      {onContinue && <ChevronRightIcon sx={{ color: 'primary.main', flexShrink: 0 }} />}
    </Stack>
  );
  return (
    <Box sx={{ ...paperCardSx(false), overflow: 'hidden' }}>
      {onContinue ? (
        <ListItemButton onClick={onContinue} sx={{ px: 2, py: 1.75, borderRadius: `${RADIUS.lg}px` }}>
          {content}
        </ListItemButton>
      ) : (
        <Box sx={{ px: 2, py: 1.75 }}>{content}</Box>
      )}
    </Box>
  );
}

function WifiNetworkRow({
  ssid,
  saved,
  expanded,
  onToggle,
  onConnect,
}: {
  ssid: string;
  saved: boolean;
  expanded: boolean;
  onToggle: () => void;
  onConnect: (password: string) => void;
}) {
  const [psk, setPsk] = useState('');
  const [show, setShow] = useState(false);
  // Ties the toggle button to the collapsible password panel for assistive tech.
  const panelId = useId();
  const canConnect = saved || psk.length > 0;

  return (
    <Box
      sx={{
        ...paperCardSx(expanded),
        overflow: 'hidden',
        transition: 'border-color 200ms ease, box-shadow 200ms ease',
        boxShadow: theme => (expanded ? `0 2px 12px ${alpha(theme.palette.primary.main, 0.12)}` : 'none'),
      }}
    >
      <ListItemButton
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        sx={{ px: 2, py: 1.75, borderRadius: `${RADIUS.lg}px` }}
      >
        <Stack direction="row" spacing={1.75} sx={{ alignItems: 'center', width: '100%' }}>
          <WifiLockIcon
            sx={{ color: expanded ? 'primary.main' : 'text.secondary', fontSize: 22, transition: 'color 200ms ease' }}
          />
          <Typography
            sx={{
              flex: 1,
              minWidth: 0,
              fontSize: TYPO.md,
              fontWeight: expanded ? FONT_WEIGHT.semibold : FONT_WEIGHT.regular,
            }}
            noWrap
          >
            {ssid}
          </Typography>
          {saved && <Chip label="Saved" />}
          <ChevronRightIcon
            sx={{
              color: 'primary.main',
              flexShrink: 0,
              transform: expanded ? 'rotate(90deg)' : 'none',
              transition: 'transform 220ms cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          />
        </Stack>
      </ListItemButton>
      <Collapse in={expanded} unmountOnExit id={panelId}>
        <Stack
          spacing={2}
          sx={{
            px: 2,
            pb: 2.25,
            pt: 2,
            borderTop: theme => `1px solid ${theme.palette.divider}`,
            bgcolor: theme => alpha(theme.palette.text.primary, 0.015),
          }}
        >
          <TextField
            value={psk}
            onChange={e => setPsk(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && canConnect) onConnect(psk);
            }}
            type={show ? 'text' : 'password'}
            label="Wi-Fi password"
            placeholder={saved ? 'Leave empty to use the saved one' : `Password for ${ssid}`}
            autoFocus
            fullWidth
            slotProps={{
              inputLabel: saved ? { shrink: true } : undefined,
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
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', color: 'text.secondary', px: 0.25 }}>
            <LockOutlinedIcon sx={{ fontSize: 15 }} />
            <Typography sx={{ fontSize: TYPO.xs, lineHeight: 1.4 }}>Encrypted on this phone before it's sent</Typography>
          </Stack>
          <Button
            variant="outlined"
            fullWidth
            onClick={() => onConnect(psk)}
            disabled={!canConnect}
            sx={{
              mt: 0.5,
              textTransform: 'none',
              fontSize: TYPO.md,
              fontWeight: FONT_WEIGHT.semibold,
              borderRadius: `${RADIUS.md}px`,
              py: 1.25,
            }}
          >
            Connect
          </Button>
        </Stack>
      </Collapse>
    </Box>
  );
}
