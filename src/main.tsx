import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { QueryClientProvider } from '@tanstack/react-query';

import App from './App';
import { BleDevEntry } from '@/ui/screens/BleWifiDebugScreen';
import { ErrorBoundary } from '@/ui/design/ErrorBoundary';
import { useResolvedThemeMode } from '@/features/theme-preference';
import { installDesktopMicShim } from '@/shared/desktop-mic-shim';
import { queryClient } from './queryClient';
import { lightTheme, darkTheme } from './theme';

// Suppress `getUserMedia({audio:true})` on macOS / Linux / Windows so
// `yarn tauri:dev` no longer steals the system microphone from other
// apps (Discord, Zoom, ...). No-op on iOS / Android. See
// `shared/desktop-mic-shim.ts` for the full rationale.
installDesktopMicShim();

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
        {/* Dev-only BLE WiFi-provisioning test harness (floating button).
            Reachable regardless of auth/scan state; touches no app flow.
            Drop the `import.meta.env.DEV` guard to ship it. */}
        {import.meta.env.DEV && <BleDevEntry />}
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
