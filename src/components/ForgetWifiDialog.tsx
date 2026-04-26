/**
 * "Forget WiFi" flow from the connected view.
 *
 * UX rules (see ASCII mockup 4d/4e):
 *   - Idle: short explanation + PIN input + Cancel/Forget buttons.
 *   - Running: Cancel button hidden, input hidden, step list visible
 *     with a clear "which step is happening now" indicator.
 *
 * BLE choreography (unchanged):
 *   1. `PIN_xxxxx`        - authenticate the privileged command.
 *   2. `WIFI_STATUS`      - learn the current SSID.
 *   3. `WIFI_FORGET ssid` - drop it.
 *   4. `disconnectDevice` - close BLE, bounce to scan screen.
 */

import { useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';

import { formatBlecError, useBleSession } from '../ble/useBleSession';

interface ForgetWifiDialogProps {
  open: boolean;
  robotName: string;
  onClose: () => void;
  onForgotten: () => void;
}

type Stage = 'idle' | 'auth' | 'reading' | 'forgetting' | 'disconnecting' | 'done';

const STAGE_ORDER: Stage[] = [
  'auth',
  'reading',
  'forgetting',
  'disconnecting',
];

const STAGE_LABELS: Record<Stage, string> = {
  idle: 'Idle',
  auth: 'Authenticating',
  reading: 'Reading current network',
  forgetting: 'Forgetting network',
  disconnecting: 'Closing Bluetooth',
  done: 'Done',
};

export default function ForgetWifiDialog({
  open,
  robotName,
  onClose,
  onForgotten,
}: ForgetWifiDialogProps) {
  const { sendCommand, disconnectDevice } = useBleSession();

  const [pin, setPin] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [failedAt, setFailedAt] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cleanPin = pin.replace(/\D/g, '').slice(0, 5);
  const busy = stage !== 'idle' && stage !== 'done';
  const canSubmit = !busy && cleanPin.length >= 4;

  const reset = (): void => {
    setPin('');
    setStage('idle');
    setFailedAt(null);
    setError(null);
  };

  const handleClose = (): void => {
    if (busy) return;
    reset();
    onClose();
  };

  const fail = (at: Stage, message: string): void => {
    setFailedAt(at);
    setError(message);
    setStage('idle');
  };

  const handleSubmit = async (): Promise<void> => {
    setError(null);
    setFailedAt(null);

    try {
      setStage('auth');
      const authResp = await sendCommand(`PIN_${cleanPin}`);
      if (!authResp.startsWith('OK:')) {
        fail(
          'auth',
          authResp.toLowerCase().includes('incorrect pin')
            ? 'Incorrect PIN. Check the 5-digit code on the robot.'
            : authResp || 'Authentication failed.'
        );
        return;
      }

      setStage('reading');
      const statusRaw = await sendCommand('WIFI_STATUS');
      const ssid = extractSsid(statusRaw);
      if (!ssid) {
        fail('reading', 'The robot does not appear to be on a WiFi network.');
        return;
      }

      setStage('forgetting');
      const forgetResp = await sendCommand(`WIFI_FORGET ${ssid}`);
      if (forgetResp.startsWith('ERROR:')) {
        fail('forgetting', forgetResp.slice('ERROR:'.length).trim() || 'WIFI_FORGET failed.');
        return;
      }

      setStage('disconnecting');
      await disconnectDevice();
      setStage('done');
      reset();
      onForgotten();
    } catch (err) {
      fail(stage === 'idle' ? 'auth' : stage, formatBlecError(err));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      fullWidth
      maxWidth="xs"
      slotProps={{ paper: { sx: { borderRadius: 3 } } }}
    >
      <DialogTitle sx={{ pb: 1, fontWeight: 700 }}>
        {busy ? 'Forgetting WiFi' : `Forget WiFi on ${robotName}`}
      </DialogTitle>

      <DialogContent>
        {busy ? (
          <StepList currentStage={stage} failedAt={null} />
        ) : failedAt ? (
          <Stack spacing={2}>
            <StepList currentStage={'idle'} failedAt={failedAt} />
            {error && (
              <Typography variant="body2" color="error.main">
                ⚠ {error}
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              Enter PIN to try again:
            </Typography>
            <PinField pin={cleanPin} setPin={setPin} disabled={false} />
          </Stack>
        ) : (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              The robot will drop its current network and reopen its hotspot.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Enter PIN to confirm:
            </Typography>
            <PinField pin={cleanPin} setPin={setPin} disabled={busy} />
          </Stack>
        )}
      </DialogContent>

      {!busy && (
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleClose} color="inherit">
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            color="warning"
            variant="contained"
            startIcon={<DeleteOutlineIcon />}
          >
            {failedAt ? 'Retry' : 'Forget'}
          </Button>
        </DialogActions>
      )}
    </Dialog>
  );
}

/* --- Step list -------------------------------------------------------- */

function StepList({
  currentStage,
  failedAt,
}: {
  currentStage: Stage;
  failedAt: Stage | null;
}) {
  const currentIdx = STAGE_ORDER.indexOf(currentStage);
  const failedIdx = failedAt ? STAGE_ORDER.indexOf(failedAt) : -1;

  return (
    <Stack spacing={1.25}>
      {STAGE_ORDER.map((s, i) => {
        const status: 'pending' | 'active' | 'done' | 'failed' =
          failedIdx >= 0 && i === failedIdx
            ? 'failed'
            : failedIdx >= 0 && i < failedIdx
              ? 'done'
              : currentIdx === -1
                ? 'pending'
                : i < currentIdx
                  ? 'done'
                  : i === currentIdx
                    ? 'active'
                    : 'pending';

        return (
          <Stack
            key={s}
            direction="row"
            alignItems="center"
            spacing={1.25}
            sx={{
              opacity: status === 'pending' ? 0.45 : 1,
              transition: 'opacity 150ms ease',
            }}
          >
            <Box sx={{ width: 18, display: 'flex', justifyContent: 'center' }}>
              {status === 'done' && (
                <CheckCircleIcon color="success" sx={{ fontSize: 18 }} />
              )}
              {status === 'active' && <CircularProgress size={16} />}
              {status === 'pending' && (
                <RadioButtonUncheckedIcon color="disabled" sx={{ fontSize: 18 }} />
              )}
              {status === 'failed' && (
                <ErrorOutlineIcon color="error" sx={{ fontSize: 18 }} />
              )}
            </Box>
            <Typography
              variant="body2"
              fontWeight={status === 'active' ? 600 : 500}
              color={status === 'failed' ? 'error.main' : 'text.primary'}
            >
              {i + 1}. {STAGE_LABELS[s]}
            </Typography>
          </Stack>
        );
      })}
    </Stack>
  );
}

/* --- PIN input -------------------------------------------------------- */

function PinField({
  pin,
  setPin,
  disabled,
}: {
  pin: string;
  setPin: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <TextField
      value={pin}
      onChange={e => setPin(e.target.value)}
      inputProps={{
        inputMode: 'numeric',
        pattern: '[0-9]*',
        autoComplete: 'off',
        maxLength: 5,
        style: {
          fontSize: '1.4rem',
          letterSpacing: '0.5em',
          textAlign: 'center',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        },
      }}
      placeholder="• • • • •"
      autoFocus
      disabled={disabled}
      fullWidth
    />
  );
}

/* --- Helpers ---------------------------------------------------------- */

function extractSsid(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { mode, connected } = parsed as { mode?: unknown; connected?: unknown };
    if (mode !== 'wlan') return null;
    if (typeof connected !== 'string') return null;
    const trimmed = connected.trim();
    if (!trimmed || trimmed.toLowerCase() === 'hotspot') return null;
    return trimmed;
  } catch {
    return null;
  }
}
