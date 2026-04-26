import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, useMediaQuery } from '@mui/material';

import App from './App';
import { lightTheme, darkTheme } from './theme';

function Root() {
  // `prefers-color-scheme` handling: follow the OS with no UI toggle. We
  // intentionally recompute the hook result on every render rather than
  // caching in state - MUI's `useMediaQuery` already listens to changes.
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const theme = prefersDark ? darkTheme : lightTheme;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline enableColorScheme />
      <App />
    </ThemeProvider>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root container');

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
