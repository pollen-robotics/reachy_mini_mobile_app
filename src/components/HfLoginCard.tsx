import {
  Avatar,
  Box,
  Button,
  CircularProgress,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import LoginIcon from '@mui/icons-material/Login';
import LogoutIcon from '@mui/icons-material/Logout';

import type { UseHfAuthResult } from '../auth/useHfAuth';

interface HfLoginCardProps {
  auth: UseHfAuthResult;
  /** Whether the daemon is reachable. Disables the login button when not. */
  daemonReachable: boolean;
}

/**
 * Compact Hugging Face login card meant to sit inline on the dashboard.
 *
 * Three visual states:
 *   * `isAuthenticated`     - show the username + a small logout button.
 *   * `isWaitingForAuth`    - user is finishing OAuth in the browser,
 *                             we display a spinner + "Waiting for login"
 *                             hint so they know the app hasn't frozen.
 *   * default (signed out)  - a primary "Sign in with Hugging Face"
 *                             button that kicks off the daemon OAuth
 *                             flow.
 *
 * The card stays deliberately small: login is optional for the v0, it is
 * only required if the user wants the daemon to access their private HF
 * content (gated models, installed apps, etc.). The conversation Space
 * itself authenticates independently when opened in the system browser.
 */
export default function HfLoginCard({ auth, daemonReachable }: HfLoginCardProps) {
  const theme = useTheme();
  const { isAuthenticated, username, avatarUrl, isWaitingForAuth, isLoading, error } = auth;

  const busy = isLoading || isWaitingForAuth;

  if (isAuthenticated) {
    return (
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={{
          px: 1.5,
          py: 1,
          borderRadius: 1.5,
          border: `1px solid ${theme.palette.divider}`,
          bgcolor: theme.palette.action.hover,
        }}
      >
        <Avatar src={avatarUrl ?? undefined} sx={{ width: 28, height: 28, fontSize: 12 }}>
          {username?.[0]?.toUpperCase() ?? '?'}
        </Avatar>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.2 }}>
            Hugging Face
          </Typography>
          <Typography variant="body2" fontWeight={600} noWrap>
            {username ?? 'Signed in'}
          </Typography>
        </Stack>
        <Button
          size="small"
          color="inherit"
          onClick={() => {
            void auth.logout();
          }}
          startIcon={<LogoutIcon fontSize="small" />}
          sx={{ textTransform: 'none' }}
        >
          Sign out
        </Button>
      </Stack>
    );
  }

  return (
    <Stack spacing={1}>
      <Button
        variant="outlined"
        fullWidth
        disabled={busy || !daemonReachable}
        onClick={() => {
          void auth.login();
        }}
        startIcon={
          busy ? <CircularProgress size={14} color="inherit" /> : <LoginIcon fontSize="small" />
        }
        sx={{ textTransform: 'none', py: 1 }}
      >
        {isWaitingForAuth
          ? 'Waiting for login in browser…'
          : isLoading
            ? 'Preparing…'
            : 'Sign in with Hugging Face'}
      </Button>

      {isWaitingForAuth && (
        <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
          Complete the login in your browser, then come back here.
        </Typography>
      )}

      {error && (
        <Box
          sx={{
            px: 1,
            py: 0.5,
            borderRadius: 1,
            bgcolor: theme.palette.error.main + '14',
            border: `1px solid ${theme.palette.error.main}44`,
          }}
        >
          <Typography variant="caption" color="error.main">
            {error}
          </Typography>
        </Box>
      )}

      {isWaitingForAuth && (
        <Button
          size="small"
          color="inherit"
          onClick={auth.cancelWaiting}
          sx={{ textTransform: 'none', alignSelf: 'center' }}
        >
          Cancel
        </Button>
      )}
    </Stack>
  );
}
