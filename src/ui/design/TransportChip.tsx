/**
 * Compact transport tag for a robot listing.
 *
 * Two well-known values get an icon + typed label (`usb`, `wifi`);
 * anything else falls through to a plain capitalised label so a
 * future daemon advertising `ethernet` / `sim` / `mockup` still
 * renders without a component update.
 *
 * The component takes a `size` prop so the same widget fits both
 * the discovery cards (slightly tighter, 20px height) and the
 * post-connect identity bar (22px). Other tweaks live as `sx`
 * overrides on the call site.
 */
import { Box, Chip } from '@mui/material';
import UsbIcon from '@mui/icons-material/Usb';
import WifiIcon from '@mui/icons-material/Wifi';

import { TYPO } from './tokens';

/**
 * Map a transport string onto the product variant it implies. The
 * link type IS the SKU: `usb` -> Reachy Mini Lite (wired, needs a host
 * computer), `wifi` -> Reachy Mini Wireless (onboard compute +
 * battery). Anything else falls through to the raw string.
 *
 * Shared by the topbar variant tag and the discovery list so both read
 * the same `Lite` / `Wireless` label.
 */
export function transportLabelOf(transport: string): string {
  if (transport === 'usb') return 'Lite';
  if (transport === 'wifi') return 'Wireless';
  return transport;
}

export interface TransportChipProps {
  transport: string;
  /**
   * Pixel height of the chip. Defaults to 20px for the discovery
   * card layout; the identity bar uses 22px for slightly more
   * breathing room next to the username chip.
   */
  height?: number;
  /**
   * Font size override. Defaults to `TYPO.tiny` (matches the
   * existing identity bar / scan card visual scale).
   */
  fontSize?: string | number;
  /**
   * Icon-only variant for the well-known transports (`usb` /
   * `wifi`). Drops the chip border + text label and renders just
   * the glyph in a muted colour, so the topbar reads "how am I
   * reaching the robot" at a glance without the chip competing
   * visually with the robot name next to it. Unknown transports
   * still fall through to the labelled chip (no icon to stand in
   * for the text). Defaults to `false` (full labelled chip).
   */
  iconOnly?: boolean;
}

export function TransportChip({
  transport,
  height = 20,
  fontSize = TYPO.tiny,
  iconOnly = false,
}: TransportChipProps) {
  const knownIcon =
    transport === 'usb' ? UsbIcon : transport === 'wifi' ? WifiIcon : null;

  // Icon-only variant (topbar): glyph alone, muted, no chrome.
  if (iconOnly && knownIcon) {
    const Icon = knownIcon;
    return (
      <Box
        aria-label={transport === 'usb' ? 'USB' : 'Wi-Fi'}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          color: theme =>
            theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.40)',
        }}
      >
        <Icon sx={{ fontSize: 16 }} />
      </Box>
    );
  }

  if (transport === 'usb') {
    return (
      <Chip
        size="small"
        icon={<UsbIcon sx={{ fontSize: 14 }} />}
        label="USB"
        variant="outlined"
        sx={{ height, fontSize, '.MuiChip-icon': { ml: 0.5 } }}
      />
    );
  }
  if (transport === 'wifi') {
    return (
      <Chip
        size="small"
        icon={<WifiIcon sx={{ fontSize: 14 }} />}
        label="Wi-Fi"
        variant="outlined"
        sx={{ height, fontSize, '.MuiChip-icon': { ml: 0.5 } }}
      />
    );
  }
  return (
    <Chip
      size="small"
      label={transport}
      variant="outlined"
      sx={{ height, fontSize, textTransform: 'capitalize' }}
    />
  );
}
