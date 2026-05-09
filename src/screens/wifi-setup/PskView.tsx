/**
 * Password entry view. Toggles between masked / revealed via the eye
 * icon (default masked, matching every desktop and mobile platform's
 * convention for Wi-Fi PSKs). Live-detects edge whitespace so the
 * user knows we'll trim on submit (catches the most common
 * "I copy-pasted from a sticker" failure mode).
 */
import { useState } from 'react';
import {
  Button,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';

import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

export function PskView({
  ssid,
  psk,
  onPskChange,
  isBusy,
  onSubmit,
  onCancel,
}: {
  ssid: string;
  psk: string;
  onPskChange: (v: string) => void;
  isBusy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const hasEdgeWhitespace = psk.length !== psk.trim().length;
  return (
    <Stack alignItems="center" spacing={2.5} sx={{ width: '100%' }}>
      <Typography
        sx={{
          fontSize: TYPO.lg,
          fontWeight: FONT_WEIGHT.semibold,
          textAlign: 'center',
        }}
      >
        {ssid}
      </Typography>
      <TextField
        fullWidth
        autoFocus
        type={revealed ? 'text' : 'password'}
        value={psk}
        onChange={(e) => onPskChange(e.target.value)}
        onKeyDown={(e) => {
          // Pressing Enter / Go on the keyboard triggers submit when
          // the form is valid - feels native on iOS/Android.
          if (e.key === 'Enter' && psk.length > 0 && !isBusy) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="Wi-Fi password"
        disabled={isBusy}
        autoComplete="current-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        helperText={
          hasEdgeWhitespace
            ? 'Leading/trailing spaces will be trimmed before sending.'
            : ' '
        }
        sx={{ maxWidth: 320 }}
        slotProps={{
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  aria-label={revealed ? 'Hide password' : 'Show password'}
                  onClick={() => setRevealed((r) => !r)}
                  edge="end"
                  disabled={isBusy}
                  size="small"
                >
                  {revealed ? <VisibilityOffIcon /> : <VisibilityIcon />}
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />
      <Stack direction="row" spacing={1.5}>
        <Button onClick={onCancel} disabled={isBusy}>
          Back
        </Button>
        <Button
          size="large"
          variant="contained"
          onClick={onSubmit}
          disabled={isBusy || psk.trim().length === 0}
        >
          {isBusy ? 'Sending…' : 'Connect'}
        </Button>
      </Stack>
    </Stack>
  );
}
