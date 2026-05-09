/**
 * Hugging Face OAuth sign-in screen.
 *
 * Routed to from the unified ScanScreen when the user taps "Sign in
 * with Hugging Face" on the remote section. Once the loopback OAuth
 * flow completes the parent persists the token (so the remote section
 * lights up with the user's robots) and pops back to the scan view.
 */
import { useCallback, useState, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import {
  cancelLoginFlow,
  loginWithHuggingFace,
} from '@/auth/oauthLoopback';
import hfLogoUrl from '@/assets/hf-logo.svg';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';

interface RemoteSignInScreenProps {
  onSignedIn: (token: string, username: string | null) => void;
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
      onSignedIn(result.token, result.username);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Sign-in failed';
      setError(friendlyAuthError(message));
    } finally {
      setBusy(false);
    }
  }, [onSignedIn]);

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
            pt: LAYOUT.safeAreaTop,
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
        spacing={3}
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
        {/* Hero title.
         *
         * Manually sized (1.875rem) to break out of the type scale used
         * elsewhere in the app: this screen is the gate to everything
         * and deserves a stronger headline than the inline section
         * titles. Weight 700 + tight letter-spacing matches the visual
         * register of native iOS / macOS hero copy.
         */}
        <Typography
          component="h1"
          sx={{
            fontSize: '1.875rem',
            fontWeight: FONT_WEIGHT.bold,
            lineHeight: 1.15,
            textAlign: 'center',
            letterSpacing: '-0.5px',
            color: 'text.primary',
            m: 0,
          }}
        >
          Sign in to Hugging Face
        </Typography>

        {/* Subtitle: explain *why* signing in is the gateway to the
         * rest of the app. Reachy Minis register themselves with
         * their owner's HF account once online, so the token we
         * obtain here is what lets us list the robots reachable on
         * the user's network. Emphasis is reserved for the two
         * concepts the user needs to register: which robots show up
         * (their Reachies) and how (their Hugging Face account).
         */}
        <Typography
          sx={{
            fontSize: TYPO.md,
            color: 'text.secondary',
            textAlign: 'center',
            maxWidth: 340,
            lineHeight: 1.5,
          }}
        >
          This is how we'll detect the{' '}
          <EmphasizedSpan>Reachies</EmphasizedSpan> linked to your{' '}
          <EmphasizedSpan>Hugging Face account</EmphasizedSpan> and let you
          connect to them from anywhere on your network.
        </Typography>

        {error ? (
          <Alert severity="error" sx={{ width: '100%', maxWidth: 420 }}>
            {error}
          </Alert>
        ) : null}

        {/* Single primary CTA. Morphs in place when the OAuth flow
         * is in flight: the HF logo turns into a small spinner and
         * the label flips to a "waiting" message, but the button's
         * size, position, and surrounding layout stay put. This
         * avoids the layout jump the previous "swap to a different
         * Stack" approach produced and keeps the user's eye anchored
         * on the same affordance from start to finish. The button is
         * `disabled` while busy so a stray re-tap can't queue a
         * second OAuth attempt. */}
        <Button
          variant="outlined"
          color="primary"
          size="large"
          disabled={busy}
          startIcon={
            busy ? (
              <CircularProgress size={18} thickness={5} color="primary" />
            ) : (
              <Box
                component="img"
                src={hfLogoUrl}
                alt=""
                aria-hidden
                sx={{
                  width: 20,
                  height: 20,
                  display: 'block',
                  // The crop of the SVG leaves a small bottom whitespace,
                  // pulling it up by a hair re-centres it next to the
                  // button label without touching the source asset.
                  transform: 'translateY(-1px)',
                }}
              />
            )
          }
          onClick={() => void startLogin()}
          sx={{
            textTransform: 'none',
            fontSize: TYPO.md,
            fontWeight: FONT_WEIGHT.semibold,
            borderWidth: 1.5,
            borderRadius: 2,
            px: 2.5,
            py: 1,
            minWidth: 260,
            // MUI dims `disabled` outlined buttons to a low-contrast
            // grey - too faded for our "active waiting" semantic.
            // Override so the button still reads as the primary
            // affordance while the OAuth tab is open.
            '&.Mui-disabled': {
              borderColor: theme => theme.palette.primary.main,
              color: theme => theme.palette.primary.main,
              opacity: 0.85,
              borderWidth: 1.5,
            },
            '&:hover': {
              borderWidth: 1.5,
            },
            '& .MuiButton-startIcon': {
              mr: 1.25,
            },
          }}
        >
          {busy ? 'Waiting for Hugging Face…' : 'Continue with Hugging Face'}
        </Button>

      </Stack>
    </Stack>
  );
}

/**
 * Inline emphasis used inside the subtitle paragraph. Bumps the
 * weight to semibold and switches back to the primary text colour so
 * the highlighted fragments visually pop out of the surrounding
 * `text.secondary` body copy.
 */
function EmphasizedSpan({ children }: { children: ReactNode }) {
  return (
    <Box
      component="span"
      sx={{ fontWeight: FONT_WEIGHT.semibold, color: 'text.primary' }}
    >
      {children}
    </Box>
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
