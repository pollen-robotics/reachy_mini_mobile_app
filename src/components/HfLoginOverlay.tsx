/**
 * Full-panel overlay shown above the conversation iframe when the user is
 * not signed in to Hugging Face.
 *
 * Ported from the desktop app. The key invariant is: while this overlay is
 * up, the <iframe> must not be mounted. That stops the embedded Space from
 * redirecting itself to `huggingface.co/login`, which would trip the
 * `X-Frame-Options: SAMEORIGIN` guard and leave the user staring at a
 * blank panel.
 */

import { Box, Button, CircularProgress, Link, Typography, useTheme } from '@mui/material';
import hfLogo from '../assets/hf-logo.svg';
import { FONT_WEIGHT, RADIUS, STATUS, TYPO } from '../styles/tokens';

export interface HfLoginOverlayProps {
  onLogin: () => void;
  onSkip?: () => void;
  isLoading?: boolean;
  isWaitingForAuth?: boolean;
  error?: string | null;
}

export default function HfLoginOverlay({
  onLogin,
  onSkip,
  isLoading,
  isWaitingForAuth,
  error,
}: HfLoginOverlayProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const busy = Boolean(isLoading || isWaitingForAuth);

  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: isDark ? 'rgba(20,20,20,0.88)' : 'rgba(248,248,250,0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        px: 4,
        gap: 2,
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
        Sign in to Hugging Face
      </Typography>

      <Typography
        sx={{
          fontSize: TYPO.sm,
          color: 'text.secondary',
          lineHeight: 1.6,
          maxWidth: 280,
        }}
      >
        Sign in to your Hugging Face account to talk with your Reachy Mini. Login opens in your
        browser; we never see your password.
      </Typography>

      <Button
        disabled={busy}
        onClick={onLogin}
        startIcon={busy ? <CircularProgress size={14} sx={{ color: 'inherit' }} /> : null}
        sx={{
          mt: 1,
          py: 1.1,
          px: 4,
          fontSize: TYPO.body,
          fontWeight: FONT_WEIGHT.bold,
          textTransform: 'none',
          borderRadius: RADIUS.xl / 8,
          color: '#fff',
          background: `linear-gradient(135deg, ${theme.palette.primary.main}, ${theme.palette.primary.dark})`,
          boxShadow: `0 2px 12px ${theme.palette.primary.main}40`,
          '&:hover': {
            background: `linear-gradient(135deg, ${theme.palette.primary.light}, ${theme.palette.primary.main})`,
            boxShadow: `0 4px 16px ${theme.palette.primary.main}55`,
            transform: 'translateY(-1px)',
          },
          '&:disabled': {
            color: 'rgba(255,255,255,0.72)',
            background: `${theme.palette.primary.main}66`,
            boxShadow: 'none',
            transform: 'none',
          },
        }}
      >
        {isWaitingForAuth ? 'Waiting for login…' : isLoading ? 'Connecting…' : 'Sign in'}
      </Button>

      {isWaitingForAuth && (
        <Typography sx={{ fontSize: TYPO.xs, color: 'text.disabled' }}>
          Finish the login in your browser
        </Typography>
      )}

      {error && (
        <Typography sx={{ fontSize: TYPO.xs, color: STATUS.error, maxWidth: 280 }}>
          {error}
        </Typography>
      )}

      {!busy && onSkip && (
        <Link
          component="button"
          onClick={onSkip}
          underline="hover"
          sx={{
            mt: 0.5,
            fontSize: TYPO.xs,
            color: 'text.disabled',
            cursor: 'pointer',
            '&:hover': { color: 'text.secondary' },
          }}
        >
          Continue without signing in
        </Link>
      )}
    </Box>
  );
}
