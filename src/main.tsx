import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, useMediaQuery } from '@mui/material';
import { QueryClientProvider } from '@tanstack/react-query';

import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { queryClient } from './queryClient';
import { lightTheme, darkTheme } from './theme';

function Root() {
  // `prefers-color-scheme` handling: follow the OS with no UI toggle. We
  // intentionally recompute the hook result on every render rather than
  // caching in state - MUI's `useMediaQuery` already listens to changes.
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const theme = prefersDark ? darkTheme : lightTheme;

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
