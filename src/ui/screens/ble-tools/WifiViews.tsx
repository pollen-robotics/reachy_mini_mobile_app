/**
 * "Change Wi-Fi network" steps of the Bluetooth tools hub.
 *
 *   menu → wifi-scanning → wifi-pick → wifi-joining ─┬─ wifi-joined
 *                                                    └─ wifi-failed ─┬─ pick again
 *                                                                    └─ rejoin the previous network
 *
 * Presentational only: `BleToolsScreen` owns the BLE sequence (PIN, KEYEX,
 * scan, `joinNetwork`) and hands us its state.
 */
import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RefreshIcon from '@mui/icons-material/Refresh';
import WifiOffRoundedIcon from '@mui/icons-material/WifiOffRounded';

import { STATUS, TYPO } from '@/ui/design/tokens';
import { WifiNetworkList } from '@/ui/widgets/wifi-picker';
import { Headline, IconHero, PrimaryButton, TextButton } from './parts';

export function WifiScanningView() {
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <CircularProgress size={40} sx={{ color: 'primary.main' }} />
      <Headline title="Finding networks" caption="Your Reachy is scanning nearby Wi-Fi (~10 s)…" />
    </Stack>
  );
}

export function WifiPickView({
  networks,
  current,
  saved,
  onConnect,
  onRescan,
}: {
  networks: string[];
  /** Network the robot is on right now (null in hotspot / offline). */
  current: string | null;
  saved: string[];
  onConnect: (password: string, ssid: string) => void;
  onRescan: () => void;
}) {
  // The robot's own network may not show up in its scan (it's associated,
  // not advertising to itself); keep it on top so the user sees where it is.
  const list = current && !networks.includes(current) ? [current, ...networks] : networks;
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline
        title="Change Wi-Fi network"
        caption={
          current
            ? `Your Reachy is on ${current}. Pick the network it should join instead.`
            : 'Your Reachy is not on Wi-Fi. Pick the network it should join.'
        }
      />
      {list.length > 0 ? (
        <WifiNetworkList networks={list} currentSsid={current} saved={saved} onConnect={onConnect} />
      ) : (
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', textAlign: 'center', maxWidth: 300 }}>
          No networks found nearby. Move the robot closer to your router and rescan.
        </Typography>
      )}
      <TextButton onClick={onRescan} startIcon={<RefreshIcon />}>
        Rescan
      </TextButton>
    </Stack>
  );
}

export function WifiJoiningView({ ssid }: { ssid: string }) {
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <CircularProgress size={40} sx={{ color: 'primary.main' }} />
      <Headline
        title={`Joining ${ssid}`}
        caption="This takes up to a minute. Keep your phone close to the robot."
      />
    </Stack>
  );
}

export function WifiJoinedView({
  ssid,
  ip,
  onMenu,
  onDone,
}: {
  ssid: string;
  ip: string;
  onMenu: () => void;
  onDone: () => void;
}) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero tint={STATUS.success}>
        <CheckCircleIcon sx={{ fontSize: 52 }} />
      </IconHero>
      <Headline
        title={`Connected to ${ssid}`}
        caption={`Your Reachy is online at ${ip}. It shows up in your robot list again once it has reconnected, usually within a minute.`}
      />
      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={onDone}>Done</PrimaryButton>
        <TextButton onClick={onMenu}>Back to tools</TextButton>
      </Stack>
    </Stack>
  );
}

export function WifiFailedView({
  ssid,
  message,
  previous,
  onPickAgain,
  onRejoinPrevious,
  onMenu,
}: {
  ssid: string;
  message: string;
  /** Network the robot was on before, still saved: offered as a way back. */
  previous: string | null;
  onPickAgain: () => void;
  onRejoinPrevious: () => void;
  onMenu: () => void;
}) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero tint={STATUS.error}>
        <WifiOffRoundedIcon sx={{ fontSize: 48 }} />
      </IconHero>
      <Headline title={`Couldn't join ${ssid}`} caption={message} />
      {previous && (
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', textAlign: 'center', maxWidth: 300 }}>
          Your Reachy may be in hotspot mode now. {previous} is still saved on it.
        </Typography>
      )}
      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={onPickAgain}>Try again</PrimaryButton>
        {previous && <PrimaryButton onClick={onRejoinPrevious}>Reconnect to {previous}</PrimaryButton>}
        <Box sx={{ textAlign: 'center' }}>
          <TextButton onClick={onMenu}>Back to tools</TextButton>
        </Box>
      </Stack>
    </Stack>
  );
}
