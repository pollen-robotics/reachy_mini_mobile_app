import { Alert } from '@mui/material';

interface ErrorBannerProps {
  message: string;
}

/**
 * Thin wrapper around MUI's `Alert` for consistent error styling across
 * screens. Kept separate from the store so screens can also pass a local
 * (non-persistent) message.
 */
export default function ErrorBanner({ message }: ErrorBannerProps) {
  return (
    <Alert severity="error" variant="outlined">
      {message}
    </Alert>
  );
}
