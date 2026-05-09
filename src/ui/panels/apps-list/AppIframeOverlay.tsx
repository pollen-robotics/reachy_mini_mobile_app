/**
 * Full-screen iframe overlay used to host an embedded Reachy Mini
 * app inside the mobile shell.
 *
 * Architecture
 * ────────────
 * - The session hook (`useRobotSession`) drives the WebRTC release
 *   when `setOpenedApp(app)` flips the host's state. This component
 *   is therefore mounted DURING the release (`session.phase ===
 *   'releasing'`) and stays mounted through the iframe's life. It
 *   reads the phase to gate its iframe `src`: the embed only dials
 *   out once the phase has reached `released`, so central has had
 *   time to free the producer slot.
 * - On close we just call `onClose()`, which flips the host state
 *   and triggers `session.reacquire()` upstream. The iframe is
 *   unmounted as part of the close.
 *
 * The host owns the handoff lifecycle; this component is dumb-pipe
 * UI on top of it.
 *
 * OAuth handover via postMessage
 * ──────────────────────────────
 * Catalog apps run in `hf_oauth: true` HF Spaces, which means a
 * full OAuth round-trip on first load. That round-trip doesn't
 * work cleanly inside an iframe (the redirect URI is the Space,
 * not our shell, so the user would have to log in again every
 * time even though they already signed in to the mobile app).
 *
 * We bypass that by sending the parent's HF access token via
 * `postMessage` once the iframe lands, mirroring the convention
 * pioneered by the vibe-coder preview iframe: the app stores the
 * token in `window.__REACHY_MINI_PREVIEW_TOKEN__` and uses
 * `robot.connect(token)` to skip OAuth. The vibe-coder injects
 * the token via `srcDoc` + `<script>` (same-origin); we have to
 * use `postMessage` because the app runs cross-origin.
 *
 * Apps that opt in to mobile-shell support add a tiny listener at
 * the top of `main.js`:
 *
 *     window.addEventListener('message', (e) => {
 *       if (e.data?.source === 'reachy-mini-shell' &&
 *           e.data?.kind === 'hf-token' &&
 *           typeof e.data.token === 'string') {
 *         window.__REACHY_MINI_PREVIEW_TOKEN__ = e.data.token;
 *       }
 *     });
 *
 * Apps that don't carry the listener fall through to the regular
 * OAuth flow inside their iframe (and the user signs in again).
 *
 * We send the token in a 3-message burst (immediate / +100ms /
 * +500ms) to handle the race where the iframe's `onLoad` fires
 * before its `main.js` has installed the listener.
 */
import {
  Box,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildAppEmbedUrl,
  type AppEmbedContext,
} from '@/features/apps/buildEmbedUrl';
import type { AppEntry } from '@/features/apps/types';
import type { SessionPhase } from '@/session/useRobotSession';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

/**
 * Hard timeout for the iframe load step. If the embed hasn't fired
 * `onLoad` within this window, we display an error overlay and let
 * the user fall back to the catalog.
 */
const IFRAME_LOAD_TIMEOUT_MS = 15_000;

interface AppIframeOverlayProps {
  app: AppEntry;
  hfToken: string;
  /** HF username, displayed by the embedded app and required by the
   * SDK's `authenticate()` cache check. Pass through whatever
   * `useRemoteHfToken` returned; the URL fragment falls back to a
   * placeholder if it's `null`. */
  hfUsername: string | null;
  robotPeerId: string;
  robotName: string;
  /**
   * Current session phase. Used to gate the iframe `src`: we only
   * navigate the iframe to the embed URL once the host's
   * `releaseForHandoff()` has resolved (`phase === 'released'`).
   * Until then the iframe stays on `about:blank` so the embed's
   * SDK doesn't dial out while our session is still releasing.
   */
  sessionPhase: SessionPhase;
  /** Called by the user (close button or hardware back). The host
   * is responsible for triggering `session.reacquire()` once this
   * fires. */
  onClose: () => void;
}

type LoadPhase = 'waiting-release' | 'loading' | 'ready' | 'error';

export default function AppIframeOverlay({
  app,
  hfToken,
  hfUsername,
  robotPeerId,
  robotName,
  sessionPhase,
  onClose,
}: AppIframeOverlayProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  const [loadPhase, setLoadPhase] = useState<LoadPhase>('waiting-release');

  // Promote to `loading` as soon as the session has actually been
  // released. Before that, the embed's `startSession` would race
  // our own `stopSession` and the central would reject one of them.
  useEffect(() => {
    if (loadPhase !== 'waiting-release') return;
    if (sessionPhase === 'released') {
      setLoadPhase('loading');
    }
  }, [sessionPhase, loadPhase]);

  const url: string = useMemo(() => {
    const ctx: AppEmbedContext = {
      hfToken,
      hfUsername,
      robotPeerId,
      robotName,
      theme: isDark ? 'dark' : 'light',
    };
    const built = buildAppEmbedUrl(app.id, app.sdk, ctx);
    // Dev-only diagnostic: surface the full iframe URL (including the
    // `#hf_token=…` fragment) so the developer can copy-paste it into
    // a desktop browser to inspect the embedded app's console /
    // network without the WebView's cross-origin opacity. The URL
    // carries an HF access token; do NOT enable this in production
    // builds.
    if (import.meta.env.DEV) {
      console.info(
        `[app-iframe] embed URL for ${app.id}\n${built}`,
      );
    }
    return built;
  }, [app.id, app.sdk, hfToken, hfUsername, robotPeerId, robotName, isDark]);

  // Origin we'll target with `postMessage`. Derived from the
  // already-built embed URL so it stays in sync with the
  // sdk-static / sdk-other fork in `buildAppEmbedUrl`. Using a
  // concrete origin (rather than `'*'`) prevents the token from
  // leaking if a different page somehow takes over the iframe.
  const targetOrigin: string = useMemo(() => {
    try {
      return new URL(url).origin;
    } catch {
      // Defensive: if URL parsing fails, fall back to the wildcard.
      // The iframe never reaches a usable state without a parseable
      // src, so practically this branch never runs.
      return '*';
    }
  }, [url]);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const burstTimersRef = useRef<number[]>([]);

  /**
   * Send the parent's HF access token to the iframe so the embedded
   * app can skip its own OAuth round-trip. See the file-level
   * "OAuth handover via postMessage" comment for the receiving
   * convention; in short, the app sets
   * `window.__REACHY_MINI_PREVIEW_TOKEN__` from the message and
   * passes it to `robot.connect(token)`.
   */
  const sendTokenToIframe = useCallback((): void => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.postMessage(
        {
          source: 'reachy-mini-shell',
          kind: 'hf-token',
          token: hfToken,
        },
        targetOrigin,
      );
    } catch (err) {
      // postMessage can throw on serialization failures or if the
      // iframe was navigated away from a same-origin context. The
      // worst case is the embed falls back to its OAuth flow,
      // which is recoverable, so just log and move on.
      console.warn('[apps] hf-token postMessage failed:', err);
    }
  }, [hfToken, targetOrigin]);

  // Clean up any pending burst timers on unmount or when the embed
  // URL changes (which would invalidate the iframe contentWindow).
  useEffect(() => {
    return () => {
      for (const id of burstTimersRef.current) window.clearTimeout(id);
      burstTimersRef.current = [];
    };
  }, [url]);

  // Hard timeout on iframe load. The HF Space cold-start can be
  // slow but anything past 15 s is a reasonable failure cue.
  const timeoutRef = useRef<number | null>(null);
  useEffect(() => {
    if (loadPhase !== 'loading') return;
    timeoutRef.current = window.setTimeout(() => {
      setLoadPhase('error');
    }, IFRAME_LOAD_TIMEOUT_MS);
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [loadPhase]);

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 1300,
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{
          px: 2,
          py: 1,
          borderBottom: t => `1px solid ${t.palette.divider}`,
          bgcolor: 'background.paper',
          flexShrink: 0,
        }}
      >
        <IconButton
          aria-label="Close app"
          onClick={onClose}
          edge="start"
          size="small"
        >
          <CloseIcon />
        </IconButton>
        <Typography
          sx={{
            flex: 1,
            fontSize: TYPO.body,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.primary',
            textAlign: 'center',
            mr: 4,
          }}
          noWrap
        >
          {app.name}
        </Typography>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {loadPhase !== 'error' && (
          <iframe
            ref={iframeRef}
            src={loadPhase === 'waiting-release' ? 'about:blank' : url}
            title={app.name}
            allow="microphone; camera; autoplay; clipboard-read; clipboard-write"
            onLoad={() => {
              if (loadPhase === 'loading') setLoadPhase('ready');
              // Burst the HF token over postMessage. The first
              // send may land before the embed's `main.js` has
              // installed its `message` listener (the listener
              // typically runs after the inline `<script
              // type="module">` SDK loader); the +100 / +500 ms
              // re-sends close that race. Apps that aren't
              // listening simply ignore the messages.
              sendTokenToIframe();
              burstTimersRef.current.push(
                window.setTimeout(sendTokenToIframe, 100),
                window.setTimeout(sendTokenToIframe, 500),
              );
            }}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              display: 'block',
              colorScheme: isDark ? 'dark' : 'light',
              backgroundColor: theme.palette.background.default,
            }}
          />
        )}

        {(loadPhase === 'waiting-release' || loadPhase === 'loading') && (
          <PhaseOverlay>
            <CircularProgress size={28} />
            <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
              {loadPhase === 'waiting-release'
                ? 'Releasing the conversation session…'
                : `Loading ${app.name}…`}
            </Typography>
          </PhaseOverlay>
        )}

        {loadPhase === 'error' && (
          <PhaseOverlay>
            <Typography sx={{ fontSize: TYPO.body, fontWeight: FONT_WEIGHT.medium }}>
              {app.name} didn't load
            </Typography>
            <Typography
              sx={{
                fontSize: TYPO.xs,
                color: 'text.secondary',
                textAlign: 'center',
                maxWidth: 320,
              }}
            >
              The app's Hugging Face Space may be cold-starting or temporarily
              unavailable. Close this view and try again in a moment.
            </Typography>
          </PhaseOverlay>
        )}
      </Box>
    </Box>
  );
}

function PhaseOverlay({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        bgcolor: 'background.default',
      }}
    >
      {children}
    </Box>
  );
}
