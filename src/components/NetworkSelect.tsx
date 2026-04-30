/**
 * NetworkSelect - MUI Select dropdown for picking a WiFi SSID.
 *
 * Visual pattern ported from the desktop app:
 *   reachy_mini_desktop_app/src/components/wifi/NetworkSelect.tsx
 *
 * Only the component visuals are reused here - the networks list is
 * still provided by the mobile app's `useWifiSetup()` hook, which
 * drives the scan over BLE (`WIFI_SCAN`).
 *
 * States:
 *   - `isLoading && networks.length === 0` → spinner + "Scanning networks…"
 *   - `networks.length === 0`               → "No networks found"
 *   - `networks.length > 0`                 → list of SSIDs, with a
 *     "✓ connected" marker next to the `connectedNetwork` entry.
 *
 * When `onRefresh` is provided, a small refresh icon is rendered
 * inside the select on the right edge (just before the chevron). It
 * stops propagation so tapping it triggers a rescan without opening
 * the dropdown.
 */

import {
  Box,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Typography,
} from '@mui/material';
import type { SelectChangeEvent, SxProps, Theme } from '@mui/material';
import ReplayIcon from '@mui/icons-material/Replay';

export interface NetworkSelectProps {
  value: string;
  onChange: (value: string) => void;
  networks?: string[];
  disabled?: boolean;
  onOpen?: () => void;
  isLoading?: boolean;
  /** SSID the robot is currently associated with. Marked with a
   *  green check and disabled (you can't "re-connect" to your own
   *  network from the setup flow). */
  connectedNetwork?: string | null;
  /** When provided, renders a refresh icon inside the select that
   *  triggers a rescan. */
  onRefresh?: () => void;
  /** Show a spinner instead of the refresh icon. */
  isRefreshing?: boolean;
  sx?: SxProps<Theme>;
}

export default function NetworkSelect({
  value,
  onChange,
  networks = [],
  disabled = false,
  onOpen,
  isLoading = false,
  connectedNetwork = null,
  onRefresh,
  isRefreshing = false,
  sx,
}: NetworkSelectProps) {
  const showRefresh = typeof onRefresh === 'function';

  return (
    <Box sx={{ position: 'relative', width: '100%' }}>
      <Select
        value={value}
        onChange={(e: SelectChangeEvent<string>) => onChange(e.target.value)}
        disabled={disabled}
        onOpen={onOpen}
        fullWidth
        displayEmpty
        MenuProps={{
          PaperProps: {
            sx: {
              maxHeight: 240,
              mt: 0.5,
            },
          },
        }}
        renderValue={(val: unknown) => {
          if (!val) {
            return (
              <Box
                component="span"
                sx={{ color: 'text.secondary', fontStyle: 'italic' }}
              >
                Select a network
              </Box>
            );
          }
          return val as string;
        }}
        sx={[
          showRefresh
            ? {
                '& .MuiSelect-select': {
                  pr: '72px !important',
                },
              }
            : {},
          ...(Array.isArray(sx) ? sx : [sx]),
        ]}
      >
        {isLoading && networks.length === 0 ? (
          <MenuItem value="" disabled>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={14} thickness={4} />
              <Box component="em" sx={{ color: 'text.secondary' }}>
                Scanning networks…
              </Box>
            </Box>
          </MenuItem>
        ) : networks.length === 0 ? (
          <MenuItem value="" disabled>
            <Box component="em" sx={{ color: 'text.secondary' }}>
              No networks found
            </Box>
          </MenuItem>
        ) : (
          networks.map((network, i) => {
            const isCurrent = Boolean(connectedNetwork && network === connectedNetwork);
            return (
              <MenuItem
                key={`${network}-${i}`}
                value={network}
                disabled={isCurrent}
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 2,
                  '&.Mui-disabled': {
                    opacity: 1,
                    color: 'text.secondary',
                  },
                }}
              >
                <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {network}
                </Box>
                {isCurrent && (
                  <Typography
                    component="span"
                    variant="caption"
                    sx={{ color: 'success.main', whiteSpace: 'nowrap' }}
                  >
                    ✓ connected
                  </Typography>
                )}
              </MenuItem>
            );
          })
        )}
      </Select>

      {showRefresh && (
        <IconButton
          size="small"
          aria-label="Rescan networks"
          disabled={disabled || isRefreshing}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onRefresh?.();
          }}
          sx={{
            position: 'absolute',
            top: '50%',
            right: 32,
            transform: 'translateY(-50%)',
            width: 32,
            height: 32,
            zIndex: 1,
            color: 'text.secondary',
          }}
        >
          {isRefreshing ? (
            <CircularProgress size={14} thickness={5} />
          ) : (
            <ReplayIcon fontSize="small" />
          )}
        </IconButton>
      )}
    </Box>
  );
}
