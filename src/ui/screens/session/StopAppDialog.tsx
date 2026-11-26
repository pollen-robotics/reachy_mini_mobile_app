/**
 * Asks before Telepresence takes the motors from an app running on the
 * robot. Both would drive the head, so the app has to stop first; the
 * conversation and Apps tabs leave it running, which is why this one asks.
 */
import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';

import { useAndroidBack } from '@/shared/tauri/useAndroidBack';
import { TYPO } from '@/ui/design/tokens';

export interface StopAppDialogProps {
  /** Display name of the running app; `null` closes the dialog. */
  appName: string | null;
  /** The stop is under way: buttons are held. */
  stopping: boolean;
  /** Why the last stop failed, or `null`. */
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function StopAppDialog({
  appName,
  stopping,
  error,
  onCancel,
  onConfirm,
}: StopAppDialogProps) {
  useAndroidBack(appName !== null && !stopping, onCancel);
  return (
    <Dialog open={appName !== null} onClose={stopping ? undefined : onCancel}>
      <DialogTitle sx={{ fontSize: TYPO.lg }}>Stop {appName}?</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ fontSize: TYPO.body }}>
          {appName} is running on Reachy. Telepresence needs the motors, so it will stop. You can
          start it again from the Apps tab.
        </DialogContentText>
        {error && (
          <DialogContentText role="alert" sx={{ fontSize: TYPO.sm, color: 'error.main', mt: 1.5 }}>
            {error}
          </DialogContentText>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={stopping}>
          Cancel
        </Button>
        <Button
          onClick={onConfirm}
          disabled={stopping}
          startIcon={stopping ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          Stop and continue
        </Button>
      </DialogActions>
    </Dialog>
  );
}
