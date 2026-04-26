/**
 * Hugging Face OAuth sign-in screen.
 *
 * Routed to from the unified ScanScreen when the user taps "Sign in
 * with Hugging Face" on the remote section. Once the loopback OAuth
 * flow completes the parent persists the token (so the remote section
 * lights up with the user's robots) and pops back to the scan view.
 */
import { useCallback, useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import LoginIcon from '@mui/icons-material/Login';

import {
  cancelLoginFlow,
  loginWithHuggingFace,
  type HfLoginResult,
} from '../auth/oauthLoopback';
import { FONT_WEIGHT, LAYOUT, TYPO } from '../styles/tokens';

interface RemoteSignInScreenProps {
  /**
   * Receives the full login result so callers can persist the refresh
   * token + expiry alongside the access token. Older call sites that
   * only need `(token, username)` can ignore the extra fields.
   */
  onSignedIn: (result: HfLoginResult) => void;
  /**
   * Optional. When provided, a back arrow is shown in the header.
   * Omit when this screen is used as the app's entry gate (no
   * destination to fall back to until the user has signed in).
   */
  onBack?: () => void;
}

export default function RemoteSignInScreen({
  onSignedIn,
  onBack,
}: RemoteSignInScreenProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startLogin = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await loginWithHuggingFace();
      onSignedIn(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Sign-in failed';
      setError(friendlyAuthError(message));
    } finally {
      setBusy(false);
    }
  }, [onSignedIn]);

  const cancel = useCallback(async () => {
    await cancelLoginFlow();
    setBusy(false);
    setError('Sign-in cancelled.');
  }, []);

  const handleBack = useCallback(async () => {
    await cancelLoginFlow();
    onBack?.();
  }, [onBack]);

  return (
    <Stack sx={{ height: '100%', width: '100%', bgcolor: 'background.default' }}>
      {onBack ? (
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{
            px: 2,
            py: 1,
            pt: 5.5,
            borderBottom: theme => `1px solid ${theme.palette.divider}`,
            flexShrink: 0,
          }}
        >
          <IconButton
            onClick={() => void handleBack()}
            size="small"
            aria-label="Back"
          >
            <ArrowBackIcon fontSize="small" />
          </IconButton>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            Sign in
          </Typography>
        </Stack>
      ) : null}

      <Stack
        spacing={2}
        sx={{
          p: 3,
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          maxWidth: LAYOUT.contentMaxWidth,
          mx: 'auto',
          width: '100%',
        }}
      >
        <Typography
          sx={{
            fontSize: TYPO.display,
            fontWeight: FONT_WEIGHT.semibold,
            textAlign: 'center',
            letterSpacing: '-0.3px',
          }}
        >
          Welcome to Reachy Mini
        </Typography>
        <Typography
          sx={{
            fontSize: TYPO.md,
            color: 'text.secondary',
            textAlign: 'center',
            maxWidth: 360,
          }}
        >
          Sign in with your Hugging Face account to discover your robots,
          locally over Bluetooth or remotely from anywhere.
        </Typography>

        {error ? (
          <Alert severity="error" sx={{ width: '100%', maxWidth: 420 }}>
            {error}
          </Alert>
        ) : null}

        {!busy ? (
          <Button
            variant="contained"
            startIcon={<LoginIcon />}
            onClick={() => void startLogin()}
            sx={{
              textTransform: 'none',
              fontWeight: 600,
              minWidth: 240,
            }}
          >
            Sign in with Hugging Face
          </Button>
        ) : (
          <Stack alignItems="center" spacing={2}>
            <CircularProgress size={28} />
            <Typography
              sx={{
                fontSize: TYPO.sm,
                color: 'text.secondary',
                textAlign: 'center',
                maxWidth: 320,
              }}
            >
              Finish signing in your browser, then come back here.
            </Typography>
            <Button
              variant="text"
              size="small"
              onClick={() => void cancel()}
              sx={{ textTransform: 'none' }}
            >
              Cancel
            </Button>
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}

/** Translate the Rust `OAuthError` tag union into a human sentence. */
function friendlyAuthError(raw: string): string {
  if (/AlreadyRunning/i.test(raw)) {
    return 'A previous sign-in is still pending. Wait a moment and retry.';
  }
  if (/Bind/i.test(raw)) {
    return 'Port 8000 is already in use on this device. Close the conflicting app and retry.';
  }
  if (/Timeout/i.test(raw)) return 'Sign-in took too long, please retry.';
  if (/Cancelled/i.test(raw)) return 'Sign-in cancelled.';
  if (/Provider/i.test(raw)) {
    return 'Hugging Face refused the sign-in. Check your account and retry.';
  }
  if (/StateMismatch/i.test(raw)) {
    return 'Sign-in security check failed, please retry.';
  }
  return raw;
}
