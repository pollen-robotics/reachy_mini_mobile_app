/**
 * NFC reader state as a tappable meta pill in the session topbar, next
 * to the Lite / Wireless and latency pills. Mirrors the desktop app's
 * NFC status button:
 *
 *   - unavailable : muted icon struck through
 *   - disabled    : muted icon
 *   - idle        : primary icon, grey dot
 *   - tag         : primary icon, green dot
 *
 * Icon only: the topbar has no room for a label, the state is in the
 * aria-label. Tapping opens Settings on the NFC section.
 */
import { Box, ButtonBase } from '@mui/material';
import NfcRoundedIcon from '@mui/icons-material/NfcRounded';

import type { NfcState } from '@/features/nfc';
import { META_PILL_HEIGHT_PX } from '@/ui/design/MetaPill';
import { RADIUS, STATUS } from '@/ui/design/tokens';

const NFC_STATE_LABEL: Record<NfcState, string> = {
  disabled: 'NFC off',
  unavailable: 'NFC unavailable',
  idle: 'No tag',
  tag: 'Tag detected',
};

interface NfcStatusPillProps {
  state: NfcState;
  onClick: () => void;
}

export function NfcStatusPill({ state, onClick }: NfcStatusPillProps) {
  const unavailable = state === 'unavailable';
  const muted = unavailable || state === 'disabled';

  return (
    <ButtonBase
      onClick={onClick}
      aria-label={`NFC reader: ${NFC_STATE_LABEL[state]}`}
      sx={theme => ({
        height: META_PILL_HEIGHT_PX,
        px: 0.625,
        flexShrink: 0,
        borderRadius: `${RADIUS.sm}px`,
        border: `1px solid ${theme.palette.divider}`,
        bgcolor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        color: muted ? 'text.disabled' : 'primary.main',
        WebkitTapHighlightColor: 'transparent',
      })}
    >
      <Box sx={{ position: 'relative', display: 'flex' }}>
        <NfcRoundedIcon sx={{ fontSize: 15 }} />
        {unavailable && (
          // Diagonal slash across the icon, like a muted speaker icon.
          <Box
            sx={theme => ({
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: '120%',
              height: '1.5px',
              bgcolor: 'currentColor',
              borderRadius: '1px',
              boxShadow: `0 0 0 1px ${theme.palette.background.default}`,
              transform: 'translate(-50%, -50%) rotate(-45deg)',
            })}
          />
        )}
        {!muted && (
          <Box
            sx={theme => ({
              position: 'absolute',
              top: -2,
              right: -3,
              width: 7,
              height: 7,
              borderRadius: '50%',
              bgcolor: state === 'tag' ? STATUS.success : theme.palette.text.disabled,
              border: `1.5px solid ${theme.palette.background.default}`,
              transition: 'background-color 0.2s ease',
            })}
          />
        )}
      </Box>
    </ButtonBase>
  );
}
