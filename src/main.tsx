import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { QueryClientProvider } from '@tanstack/react-query';

import App from './App';
import { ErrorBoundary } from '@/ui/design/ErrorBoundary';
import { useResolvedThemeMode } from '@/features/theme-preference';
import { installDesktopMicShim } from '@/shared/desktop-mic-shim';
import { installAndroidInsetsBridge } from '@/shared/android-insets';
import { installLowLatencyVideo } from '@/features/robot-session/low-latency-video';
import { queryClient } from './queryClient';
import { lightTheme, darkTheme } from './theme';

// Suppress `getUserMedia({audio:true})` on macOS / Linux / Windows so
// `yarn tauri:dev` no longer steals the system microphone from other
// apps (Discord, Zoom, ...). No-op on iOS / Android. See
// `shared/desktop-mic-shim.ts` for the full rationale.
installDesktopMicShim();

// Populate `--inset-top/--inset-bottom/...` from the Android host activity
// so bottom bars clear the system navigation bar under edge-to-edge. No-op
// everywhere else. See `shared/android-insets.ts`.
installAndroidInsetsBridge();
// Must run before any robot session creates its RTCPeerConnection: the
// low-latency video transform can only be installed at `track` time.
installLowLatencyVideo();

function Root() {
  // Resolved theme = user pick collapsed to a concrete palette
  // (`light | dark`). When the user kept the default `system`
  // option the resolver tracks `prefers-color-scheme` live; when
  // they explicitly picked light or dark the OS state is ignored.
  // The resolver is wired to a tiny external store so both the
  // toggle UI in `HelpAndSupportSheet` and the `ThemeProvider`
  // boundary stay in sync without prop drilling.
  const resolved = useResolvedThemeMode();
  const theme = resolved === 'dark' ? darkTheme : lightTheme;

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline enableColorScheme />
        <App />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root container');

createRoot(container).render(
  <StrictMode>
    {/* ErrorBoundary lives OUTSIDE the ThemeProvider on purpose: a
        crash inside MUI itself (or its theme creation) would leave
        a regular boundary unmounted alongside the broken tree.
        Keeping the boundary at the React-tree root with a
        framework-light fallback means we always have *something*
        to render, even if MUI is the source of the failure. */}
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>
);
