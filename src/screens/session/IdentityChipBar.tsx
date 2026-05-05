/**
 * Compact chip strip used inside the session header.
 *
 * Mirrors the chip taxonomy from `ScanScreen` so the user retains
 * visual continuity with the discovery card they just tapped:
 *
 *   - hardware id (`id:xxxxx`)  - 5-char monospace tag
 *   - transport icon + label    - USB / Wi-Fi / freeform
 *   - signed-in HF user         - `@username`
 *
 * Pure presentational. The host (`RobotSessionScreen`) decides which
 * fields are available; missing values just render as nothing rather
 * than placeholder text. The component renders a tight single-line
 * row with no wrapping so it can sit inline next to the back button
 * and robot name without breaking the header into multiple lines.
 */
import { Chip, Stack } from '@mui/material';
import UsbIcon from '@mui/icons-material/Usb';
import WifiIcon from '@mui/icons-material/Wifi';

import { TYPO } from '../../styles/tokens';

interface IdentityChipBarProps {
  hardwareId: string | null;
  transport: string;
  username: string | null;
}

export default function IdentityChipBar({
  hardwareId,
  transport,
  username,
}: IdentityChipBarProps) {
  return (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      sx={{
        flexShrink: 0,
        flexWrap: 'nowrap',
      }}
    >
      {hardwareId && (
        <Chip
          label={`id:${hardwareId.slice(0, 5)}`}
          size="small"
          variant="outlined"
          sx={{
            height: 22,
            fontSize: TYPO.tiny,
            fontFamily: 'monospace',
          }}
        />
      )}
      <TransportChip transport={transport} />
      {username && (
        <Chip
          label={`@${username}`}
          size="small"
          variant="outlined"
          sx={{
            height: 22,
            fontSize: TYPO.tiny,
            maxWidth: 120,
            '.MuiChip-label': {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          }}
        />
      )}
    </Stack>
  );
}

function TransportChip({ transport }: { transport: string }) {
  if (transport === 'usb') {
    return (
      <Chip
        icon={<UsbIcon sx={{ fontSize: 14 }} />}
        label="USB"
        size="small"
        variant="outlined"
        sx={{ height: 22, fontSize: TYPO.tiny, '.MuiChip-icon': { ml: 0.5 } }}
      />
    );
  }
  if (transport === 'wifi') {
    return (
      <Chip
        icon={<WifiIcon sx={{ fontSize: 14 }} />}
        label="Wi-Fi"
        size="small"
        variant="outlined"
        sx={{ height: 22, fontSize: TYPO.tiny, '.MuiChip-icon': { ml: 0.5 } }}
      />
    );
  }
  return (
    <Chip
      label={transport}
      size="small"
      variant="outlined"
      sx={{
        height: 22,
        fontSize: TYPO.tiny,
        textTransform: 'capitalize',
      }}
    />
  );
}
