/**
 * SSID picker. Lists the networks returned by `WIFI_SCAN`, with a
 * banner above the list when the scan itself raised an error
 * (busy daemon, expired auth, ...) so the user reads a real cause
 * instead of "No Wi-Fi networks found" - the most common failure
 * mode here.
 */
import {
  Box,
  CircularProgress,
  IconButton,
  List,
  ListItemButton,
  Stack,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import WifiIcon from '@mui/icons-material/Wifi';

import { FONT_WEIGHT, TYPO } from '../../styles/tokens';

export function ScanView({
  isBusy,
  ssids,
  error,
  onPick,
  onRefresh,
}: {
  isBusy: boolean;
  ssids: string[];
  error: string | null;
  onPick: (ssid: string) => void;
  onRefresh: () => void;
}) {
  return (
    <Stack spacing={2} sx={{ width: '100%' }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
      >
        <Typography sx={{ fontSize: TYPO.lg, fontWeight: FONT_WEIGHT.semibold }}>
          Pick a network
        </Typography>
        <IconButton aria-label="Refresh" onClick={onRefresh} disabled={isBusy}>
          <RefreshIcon />
        </IconButton>
      </Stack>
      {error && !isBusy && (
        <Box
          sx={{
            py: 1.5,
            px: 2,
            borderRadius: 2,
            bgcolor: 'error.dark',
            color: 'error.contrastText',
            display: 'flex',
            flexDirection: 'column',
            gap: 0.5,
          }}
        >
          <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium }}>
            Couldn&apos;t scan
          </Typography>
          <Typography sx={{ fontSize: TYPO.xs, opacity: 0.85 }}>
            {error}
          </Typography>
        </Box>
      )}
      {isBusy && ssids.length === 0 ? (
        <Stack alignItems="center" spacing={1} sx={{ py: 4 }}>
          <CircularProgress size={24} />
          <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
            Scanning…
          </Typography>
        </Stack>
      ) : ssids.length === 0 ? (
        <Box
          sx={{
            py: 4,
            px: 2,
            borderRadius: 2,
            bgcolor: 'action.hover',
            color: 'text.secondary',
            textAlign: 'center',
          }}
        >
          <Typography sx={{ fontSize: TYPO.sm }}>
            No Wi-Fi networks found. Tap refresh to retry.
          </Typography>
        </Box>
      ) : (
        <List
          disablePadding
          sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}
        >
          {ssids.map((ssid) => (
            <ListItemButton
              key={ssid}
              onClick={() => onPick(ssid)}
              sx={{
                p: 2,
                borderRadius: 2,
                border: (t) => `1px solid ${t.palette.divider}`,
              }}
            >
              <WifiIcon sx={{ mr: 2 }} />
              <Typography sx={{ fontWeight: 500 }}>{ssid}</Typography>
            </ListItemButton>
          ))}
        </List>
      )}
    </Stack>
  );
}
