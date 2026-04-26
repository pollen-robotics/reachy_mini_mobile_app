/**
 * "Forget Wi-Fi" dialog. Reachable from the live-session menu for
 * both LAN and remote sessions.
 *
 * What changed in PR-F
 * ────────────────────
 * Pre-PR-F this dialog drove a BLE-only choreography (PIN auth →
 * `WIFI_STATUS` over BLE → `WIFI_FORGET ssid` over BLE) and was
 * gated on `isLocal`. With `RobotClient` in place the same intent
 * is now expressed against the daemon's HTTP surface, which routes
 * over LAN HTTP or the WebRTC proxy depending on transport. The
 * feature is therefore available at parity for both modes, and the
 * BLE PIN gate is dropped (the HTTP endpoint is already trust-bound
 * by transport, see `forgetCurrentNetwork.ts`).
 *
 * UX rules
 * ────────
 *   - Idle: short explanation + Cancel/Forget buttons. No PIN input.
 *   - Running: Cancel hidden, step list visible with a clear
 *     active/done/failed indicator on each step.
 *   - Failure: list shows which step broke, with a typed message,
 *     and a Retry button reuses the same handler.
 *
 * Choreography (transport-agnostic)
 * ─────────────────────────────────
 *   1. `GET /api/wifi/status`        - learn the current SSID.
 *   2. `POST /api/wifi/forget?ssid=` - drop it (daemon falls back
 *                                      to hotspot server-side).
 *   3. The parent reuses its normal "back" path so the engine
 *      teardown still lands `endSession` and motors get put to
 *      sleep before the BLE/WebRTC link is severed.
 */
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import { useState } from 'react';

import type { RobotClient } from '../robot-client/types';
import { forgetCurrentNetwork } from '../wifi/forgetCurrentNetwork';

interface ForgetWifiDialogProps {
  open: boolean;
  robotName: string;
  /**
   * Transport-agnostic client. When `null` (e.g. the live phase has
   * been left), the dialog disables its primary action so the user
   * can't trigger a no-op request.
   */
  client: RobotClient | null;
  onClose: () => void;
  /**
   * Called once the daemon confirmed it forgot the network. The
   * parent typically follows up with the same teardown it runs on a
   * manual back, since the robot is about to drop the network the
   * current transport rides on (LAN HTTP) or the BLE-paired SSID is
   * gone (remote keeps working until the daemon flips to hotspot).
   */
  onForgotten: () => void;
}

type Stage = 'idle' | 'reading' | 'forgetting' | 'done';

const STAGE_ORDER: Stage[] = ['reading', 'forgetting'];

const STAGE_LABELS: Record<Stage, string> = {
  idle: 'Idle',
  reading: 'Reading current network',
  forgetting: 'Forgetting network',
  done: 'Done',
};

export default function ForgetWifiDialog({
  open,
  robotName,
  client,
  onClose,
  onForgotten,
}: ForgetWifiDialogProps) {
  const [stage, setStage] = useState<Stage>('idle');
  const [failedAt, setFailedAt] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = stage !== 'idle' && stage !== 'done';
  const canSubmit = !busy && client !== null;

  const reset = (): void => {
    setStage('idle');
    setFailedAt(null);
    setError(null);
  };

  const handleClose = (): void => {
    if (busy) return;
    reset();
    onClose();
  };

  const handleSubmit = async (): Promise<void> => {
    if (!client) return;
    setError(null);
    setFailedAt(null);

    setStage('reading');
    const result = await forgetCurrentNetwork(client);

    if (!result.ok) {
      // Map the typed error code into the step that broke. The
      // error codes are stable so the dialog doesn't rely on
      // free-form parsing.
      const at: Stage =
        result.error === 'forget-failed' ? 'forgetting' : 'reading';
      setFailedAt(at);
      setError(result.errorMessage ?? 'Failed to forget the network.');
      setStage('idle');
      return;
    }

    setStage('done');
    reset();
    onForgotten();
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
        {busy ? 'Forgetting Wi-Fi' : `Forget Wi-Fi on ${robotName}`}
      </DialogTitle>

      <DialogContent>
        {busy ? (
          <StepList currentStage={stage} failedAt={null} />
        ) : failedAt ? (
          <Stack spacing={2}>
            <StepList currentStage="idle" failedAt={failedAt} />
            {error ? (
              <Typography variant="body2" color="error.main">
                ⚠ {error}
              </Typography>
            ) : null}
            <Typography variant="body2" color="text.secondary">
              Tap retry to try again.
            </Typography>
          </Stack>
        ) : (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              The robot will drop its current Wi-Fi network and reopen its hotspot.
              You may need to re-pair from the discovery screen afterwards.
            </Typography>
          </Stack>
        )}
      </DialogContent>

      {!busy ? (
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
      ) : null}
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
              {status === 'done' ? (
                <CheckCircleIcon color="success" sx={{ fontSize: 18 }} />
              ) : null}
              {status === 'active' ? <CircularProgress size={16} /> : null}
              {status === 'pending' ? (
                <RadioButtonUncheckedIcon color="disabled" sx={{ fontSize: 18 }} />
              ) : null}
              {status === 'failed' ? (
                <ErrorOutlineIcon color="error" sx={{ fontSize: 18 }} />
              ) : null}
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
