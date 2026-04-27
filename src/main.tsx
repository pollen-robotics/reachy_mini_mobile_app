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

// NOTE: StrictMode disabled on purpose. We tested it on - the lifecycle
// stores (engineLifecyclePromise, setDesiredState, trajectoryGate) absorb
// the double-invokes correctly, but the duplicated effect runs make
// production-like log traces noisy and waste daemon round-trips during
// the BLE handshake (every BLE GATT read fires twice, every WebRTC ICE
// trace prints twice). Re-enable locally if you want to stress-test
// StrictMode-safety; keep it off by default for a calmer dev console.
createRoot(container).render(<Root />);
