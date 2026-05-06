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
import { Chip } from '@mui/material';
import UsbIcon from '@mui/icons-material/Usb';
import WifiIcon from '@mui/icons-material/Wifi';

import { TYPO } from '../styles/tokens';

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
}

export function TransportChip({
  transport,
  height = 20,
  fontSize = TYPO.tiny,
}: TransportChipProps) {
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
