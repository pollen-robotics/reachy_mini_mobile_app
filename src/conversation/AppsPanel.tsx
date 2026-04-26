/**
 * Apps panel - iframe-based launcher for Hugging Face Spaces.
 *
 * UX:
 *   - By default, renders a vertical list of apps (grid on wider screens).
 *   - Tapping an app opens it fullscreen in an `<iframe>` with the HF token
 *     bridged via the URL hash fragment (same convention as the Space's
 *     `consumeTokenFromHash`).
 *   - A top row in the opened view lets the user go back to the list.
 *
 * The catalog is hardcoded for now (user's choice). It's easy to move to
 * a daemon-served manifest later if / when we want apps to be
 * dynamically discoverable.
 */
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  Alert,
  Box,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import { fetchHfToken } from '../auth/fetchHfToken';

export interface AppCatalogEntry {
  id: string;
  name: string;
  tagline: string;
  spaceUrl: string;
  emoji: string;
}

const APPS: readonly AppCatalogEntry[] = [
  {
    id: 'webrtc_example',
    name: 'WebRTC Demo',
    tagline: 'Low-latency voice loop by cduss',
    spaceUrl: 'https://huggingface.co/spaces/cduss/webrtc_example',
    emoji: '🎙️',
  },
];

interface AppsPanelProps {
  daemonHost: string | null;
  isAuthenticated: boolean;
}

export function AppsPanel({ daemonHost, isAuthenticated }: AppsPanelProps): React.ReactElement {
  const [openedApp, setOpenedApp] = useState<AppCatalogEntry | null>(null);

  if (openedApp) {
    return (
      <AppViewer
        app={openedApp}
        daemonHost={daemonHost}
        isAuthenticated={isAuthenticated}
        onBack={() => setOpenedApp(null)}
      />
    );
  }

  return <AppsList apps={APPS} onOpen={setOpenedApp} />;
}

/* --- Catalog list ---------------------------------------------------- */

function AppsList({
  apps,
  onOpen,
}: {
  apps: readonly AppCatalogEntry[];
  onOpen: (app: AppCatalogEntry) => void;
}): React.ReactElement {
  const theme = useTheme();

  return (
    <Stack sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 2, py: 3 }} spacing={2}>
      <Stack spacing={0.5}>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          Apps
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Extra experiences you can run with your Reachy.
        </Typography>
      </Stack>

      <Stack spacing={1.25}>
        {apps.map((app) => (
          <Box
            key={app.id}
            component="button"
            onClick={() => onOpen(app)}
            sx={{
              all: 'unset',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              p: 2,
              borderRadius: 2,
              border: `1px solid ${theme.palette.divider}`,
              bgcolor: 'background.paper',
              transition: 'border-color 120ms ease, transform 120ms ease',
              '&:hover': {
                borderColor: theme.palette.primary.main,
              },
              '&:active': {
                transform: 'scale(0.995)',
              },
            }}
          >
            <Box
              sx={{
                width: 48,
                height: 48,
                borderRadius: 1.5,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 26,
                bgcolor: 'action.hover',
                flex: 'none',
              }}
            >
              {app.emoji}
            </Box>
            <Stack sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body1" sx={{ fontWeight: 600 }} noWrap>
                {app.name}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {app.tagline}
              </Typography>
            </Stack>
            <OpenInNewIcon fontSize="small" color="action" />
          </Box>
        ))}
      </Stack>

      {apps.length === 0 ? (
        <Box
          sx={{
            p: 4,
            textAlign: 'center',
            border: `1px dashed ${theme.palette.divider}`,
            borderRadius: 2,
          }}
        >
          <Typography variant="body2" color="text.secondary">
            No apps available.
          </Typography>
        </Box>
      ) : null}
    </Stack>
  );
}

/* --- App viewer ------------------------------------------------------ */

function AppViewer({
  app,
  daemonHost,
  isAuthenticated,
  onBack,
}: {
  app: AppCatalogEntry;
  daemonHost: string | null;
  isAuthenticated: boolean;
  onBack: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    setIframeSrc(null);
    setError(null);

    if (!isAuthenticated) {
      setError('Sign in with Hugging Face from the menu to run apps.');
      return;
    }
    if (!daemonHost) {
      setError('No daemon host available.');
      return;
    }

    void (async () => {
      try {
        const token = await fetchHfToken(daemonHost);
        if (cancelledRef.current) return;
        if (!token) {
          setError('Sign-in lost. Please sign in again from the menu.');
          return;
        }
        const baseUrl = buildEmbedUrl(app.spaceUrl, theme.palette.mode);
        const withToken = `${baseUrl}#hf_token=${encodeURIComponent(token)}`;
        setIframeSrc(withToken);
      } catch (err) {
        if (cancelledRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to fetch HF token');
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [app.spaceUrl, daemonHost, isAuthenticated, theme.palette.mode]);

  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{
          px: 1,
          py: 1,
          borderBottom: `1px solid ${theme.palette.divider}`,
          flexShrink: 0,
        }}
      >
        <IconButton size="small" onClick={onBack} aria-label="Back to apps">
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
            {app.name}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {app.tagline}
          </Typography>
        </Stack>
      </Stack>

      {error ? (
        <Alert severity="warning" sx={{ m: 1 }}>
          {error}
        </Alert>
      ) : null}

      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {iframeSrc ? (
          <iframe
            src={iframeSrc}
            title={app.name}
            allow="microphone; autoplay; clipboard-read; clipboard-write"
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              display: 'block',
              colorScheme: theme.palette.mode,
            }}
          />
        ) : !error ? (
          <Stack
            alignItems="center"
            justifyContent="center"
            sx={{ position: 'absolute', inset: 0 }}
          >
            <CircularProgress size={28} />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 2 }}>
              Loading {app.name}…
            </Typography>
          </Stack>
        ) : null}
      </Box>
    </Stack>
  );
}

/**
 * Convert a canonical Space URL into its `*.hf.space` embedded variant so
 * the iframe doesn't bounce through `huggingface.co/spaces/...` (which
 * may set `X-Frame-Options` on some paths).
 */
function buildEmbedUrl(spaceUrl: string, mode: 'light' | 'dark'): string {
  // https://huggingface.co/spaces/<owner>/<name> → https://<owner>-<name>.hf.space
  const match = /^https?:\/\/huggingface\.co\/spaces\/([^/]+)\/([^/?#]+)/i.exec(spaceUrl);
  if (match) {
    const owner = match[1].toLowerCase();
    const name = match[2].toLowerCase();
    return `https://${owner}-${name}.hf.space/?embedded=1&theme=${mode}`;
  }
  return spaceUrl;
}
