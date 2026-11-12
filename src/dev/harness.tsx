/**
 * Dev-only visual harness for the Apps tab.
 *
 * Mounts `<AppsTabView>` alone (real theme, real query client, real
 * public catalog fetch, a fake in-memory robot for the Python apps - no
 * robot session, no Tauri runtime) so the
 * tab's layout can be inspected in a plain browser during design
 * iterations. Reachable only via `/harness.html` under `vite dev`;
 * never linked from the app and not part of the Tauri bundle entry.
 */
import { createRoot } from 'react-dom/client';
import { Box, CssBaseline, ThemeProvider } from '@mui/material';
import { QueryClientProvider } from '@tanstack/react-query';

import { useRobotApps } from '@/features/robot-apps/useRobotApps';
import AppsTabView from '@/ui/panels/apps-list/AppsTabView';
import { queryClient } from '@/queryClient';
import { lightTheme } from '@/theme';

import { createFakeRobotApps } from './fakeRobotApps';

const fakeRobot = createFakeRobotApps();
const getFakeRobot = () => fakeRobot;

function Harness() {
  // Robot apps run against an in-memory daemon (see `fakeRobotApps.ts`).
  const robotApps = useRobotApps({
    robotId: 'harness',
    getRobot: getFakeRobot,
    active: true,
    online: true,
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={lightTheme}>
        <CssBaseline enableColorScheme />
        {/* Mirrors the host column in `RobotSessionScreen`: a
            max-width-capped centred flex column the tab body fills. */}
        <Box
          sx={{
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            maxWidth: 420,
            mx: 'auto',
          }}
        >
          <AppsTabView
            onOpen={app => console.log('[harness] open', app.id)}
            robotApps={robotApps}
          />
        </Box>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root container');
createRoot(container).render(<Harness />);
