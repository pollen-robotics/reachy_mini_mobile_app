/**
 * Hugging Face OAuth sign-in screen.
 *
 * Single source of truth for the user-facing OAuth flow. Shown
 * full-screen by `App.tsx` until a token is present in
 * `useRemoteHfToken` state; nothing else in the app surfaces an HF
 * sign-in UI. Earlier iterations had a second `HfLoginOverlay`
 * component covering the conversation when the LAN daemon rejected
 * the auto-seeded token, but having two parallel sign-in surfaces
 * for the same user / same HF account was confusing and prone to
 * loops - the recovery path now is: sign out at the gate (top-bar
 * menu in `RobotSessionScreen`), sign back in, gate auto-seeds the
 * fresh token to the daemon.
 *
 * Button variant
 * ──────────────
 * Uses `outlined` + `primary` here intentionally: at the gate
 * there is no other content competing for the user's attention, so
 * a softer outlined treatment reads as "calm, expected next step"
 * rather than an urgent gradient CTA.
 */
import { useCallback, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Link,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import {
  cancelLoginFlow,
  loginWithHuggingFace,
  type HfLoginResult,
} from '../auth/oauthLoopback';
import hfLogo from '../assets/hf-logo.svg';
import { FONT_WEIGHT, LAYOUT, RADIUS, TYPO } from '../styles/tokens';

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
          textAlign: 'center',
        }}
      >
        <Box
          component="img"
          src={hfLogo}
          alt="Hugging Face"
          sx={{ width: 64, height: 64, mb: 0.5 }}
        />

        <Typography
          sx={{
            fontSize: TYPO.xl,
            fontWeight: FONT_WEIGHT.bold,
            color: 'text.primary',
            letterSpacing: '-0.2px',
          }}
        >
          Welcome to Reachy Mini
        </Typography>

        <Typography
          sx={{
            fontSize: TYPO.sm,
            color: 'text.secondary',
            lineHeight: 1.6,
            maxWidth: 320,
          }}
        >
          Sign in with your Hugging Face account to discover your robots,
          locally over Bluetooth or remotely from anywhere.
        </Typography>

        {error ? (
          <Alert severity="error" sx={{ width: '100%', maxWidth: 360 }}>
            {error}
          </Alert>
        ) : null}

        {!busy ? (
          <Button
            variant="outlined"
            color="primary"
            startIcon={
              <Box
                component="img"
                src={hfLogo}
                alt=""
                sx={{ width: 18, height: 18 }}
              />
            }
            onClick={() => void startLogin()}
            sx={{
              mt: 1,
              py: 1.1,
              px: 4,
              minWidth: 240,
              fontSize: TYPO.body,
              fontWeight: FONT_WEIGHT.semibold,
              textTransform: 'none',
              borderRadius: RADIUS.xl / 8,
              borderWidth: 1.5,
              '&:hover': { borderWidth: 1.5 },
            }}
          >
            Sign in with Hugging Face
          </Button>
        ) : (
          <Stack alignItems="center" spacing={2} sx={{ mt: 1 }}>
            <CircularProgress size={24} />
            <Typography
              sx={{
                fontSize: TYPO.xs,
                color: 'text.secondary',
                maxWidth: 320,
              }}
            >
              Finish signing in your browser, then come back here.
            </Typography>
            <Link
              component="button"
              onClick={() => void cancel()}
              underline="hover"
              sx={{
                fontSize: TYPO.xs,
                color: 'text.disabled',
                cursor: 'pointer',
                '&:hover': { color: 'text.secondary' },
              }}
            >
              Cancel
            </Link>
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
