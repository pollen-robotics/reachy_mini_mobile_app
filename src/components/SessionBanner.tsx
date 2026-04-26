/**
 * Soft banner shown over the live conversation surface when the
 * session monitor reports a degraded or lost state.
 *
 * Why two severities
 * ──────────────────
 * - `degraded` is "we just missed a probe, hold on": dismiss-able
 *   spinner, no destructive action. Most flaps recover within the
 *   grace window and the banner self-dismisses.
 * - `lost` is "the daemon is gone or the engine errored": the
 *   primary CTA is `Disconnect` so the user gets back to the scan
 *   screen rather than staring at a frozen UI. Retry is exposed
 *   secondarily because some failures (transient WebRTC drops) do
 *   recover on a fresh handshake.
 *
 * The banner is rendered absolutely over the conversation area so
 * the underlying engine isn't unmounted: a recovery flips the
 * banner away without rebuilding the audio pipeline.
 */
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Stack,
} from '@mui/material';

import type { SessionHealth } from '../session/types';

interface SessionBannerProps {
  health: SessionHealth;
  /** Trigger a one-shot probe + retry. The screen owns what that means. */
  onRetry?: () => void;
  /** Hard exit: tear the session down and go back to discovery. */
  onDisconnect: () => void;
}

export default function SessionBanner({
  health,
  onRetry,
  onDisconnect,
}: SessionBannerProps) {
  if (health.status === 'healthy' || health.status === 'connecting') {
    return null;
  }

  const isLost = health.status === 'lost';
  const message =
    health.diagnostic?.message ??
    (isLost ? 'Session lost.' : 'Connection unstable, retrying…');

  return (
    <Box
      sx={{
        position: 'absolute',
        top: 8,
        left: 8,
        right: 8,
        zIndex: 5,
        pointerEvents: 'auto',
      }}
    >
      <Alert
        severity={isLost ? 'error' : 'warning'}
        variant="filled"
        sx={{ alignItems: 'center', borderRadius: 2 }}
        action={
          <Stack direction="row" spacing={1}>
            {!isLost ? <CircularProgress size={18} color="inherit" /> : null}
            {isLost && onRetry ? (
              <Button color="inherit" size="small" onClick={onRetry}>
                Retry
              </Button>
            ) : null}
            {isLost ? (
              <Button color="inherit" size="small" onClick={onDisconnect}>
                Disconnect
              </Button>
            ) : null}
          </Stack>
        }
      >
        <AlertTitle sx={{ fontWeight: 700, mb: 0 }}>
          {isLost ? 'Session lost' : 'Reconnecting…'}
        </AlertTitle>
        {message}
      </Alert>
    </Box>
  );
}
