/**
 * Soft warning banner shown above the conversation panel when the
 * connected daemon advertises an older `api_revision` than the mobile
 * app expects.
 *
 * Design choices
 * ──────────────
 * - **Non-blocking**. The session keeps working; we just warn that
 *   "some features may not work". Hard-blocking on a version mismatch
 *   would be hostile, especially as most users get to the conversation
 *   path with no version-gated calls in flight.
 * - **Dismissable**. The banner lives for the duration of the session
 *   only - we don't persist a "don't show again" flag because the
 *   user may swap robots and the next one might be on a fresh build.
 * - **No CTA**. Reachy update flows live on the daemon dashboard, not
 *   here; pointing the user at instructions would be useful but
 *   out-of-scope for PR-D.
 */
import { useState } from 'react';
import { Alert, Box, Collapse, IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

interface OutdatedDaemonBannerProps {
  /** Optional version string to surface to the user (e.g. "0.7.3"). */
  daemonVersion: string | null;
}

export default function OutdatedDaemonBanner({
  daemonVersion,
}: OutdatedDaemonBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  return (
    <Collapse in={!dismissed}>
      <Box sx={{ px: 1.5, pt: 1 }}>
        <Alert
          severity="warning"
          variant="outlined"
          sx={{ fontSize: '0.78rem', py: 0.5 }}
          action={
            <IconButton
              size="small"
              aria-label="Dismiss"
              onClick={() => setDismissed(true)}
            >
              <CloseIcon fontSize="inherit" />
            </IconButton>
          }
        >
          {daemonVersion
            ? `Robot daemon ${daemonVersion} is older than this app expects. Some features may not work; consider updating from the robot dashboard.`
            : 'Robot daemon is older than this app expects. Some features may not work; consider updating from the robot dashboard.'}
        </Alert>
      </Box>
    </Collapse>
  );
}
