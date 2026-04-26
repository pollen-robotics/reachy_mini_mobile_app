import { useState } from 'react';
import { Box } from '@mui/material';

import ScanScreen from './screens/ScanScreen';
import WifiSetupScreen from './screens/WifiSetupScreen';
import RemoteSignInScreen from './screens/RemoteSignInScreen';
import RobotSessionScreen, {
  type ConnectionTarget,
} from './screens/RobotSessionScreen';
import {
  useBleSession,
  useInitBleListeners,
} from './ble/useBleSession';
import { useHfTokenRefresh } from './auth/useHfTokenRefresh';
import { useRemoteHfToken } from './auth/useRemoteHfToken';
import { createLogger } from './logger';

const logger = createLogger('app');

type Screen = 'scan' | 'session' | 'wifi-setup';

/**
 * Root component.
 *
 * Auth gate
 * ─────────
 * Hugging Face sign-in is the entry point of the app: while no
 * token is present we render `RemoteSignInScreen` full-screen,
 * with no back button. Once signed in the rest of the app boots,
 * starting on the unified discovery view. Sign-out clears the
 * token, which immediately collapses everything back to the gate.
 *
 * After the gate
 * ──────────────
 * One discovery view (`ScanScreen`) lists both Bluetooth and over-
 * the-internet robots. Tapping either one routes to a single
 * `RobotSessionScreen` that owns the entire connection lifecycle:
 *
 *   - The same 4-step stepper for both transports (mode-specific
 *     labels: `Bluetooth → Network → Daemon → Conversation` for LAN,
 *     `Hugging Face → WebRTC → Daemon → Conversation` for remote).
 *   - The same wake/sleep choreography on both ends of the visit
 *     (the robot wakes when the user lands, goes to sleep when
 *     they back out, regardless of how the bytes flowed).
 *   - The same post-connect chrome (top bar with menu, daemon
 *     status pill).
 *
 * The legacy split (separate TransitionScreen / ConnectedScreen for
 * LAN, RemoteConverseScreen for remote) is gone: those three screens
 * collapsed into `RobotSessionScreen`, which branches internally on
 * `target.kind`.
 */
export default function App() {
  const [screen, setScreen] = useState<Screen>('scan');
  const [target, setTarget] = useState<ConnectionTarget | null>(null);
  const { disconnectDevice, connectedAddress } = useBleSession();
  const tokenState = useRemoteHfToken();
  const { token, username, setToken, clear } = tokenState;

  useInitBleListeners();
  // Auto-refresh the HF access token in the background. When HF
  // doesn't issue a refresh token (depending on client config) this
  // is a no-op and the user re-auths on next 401 instead.
  useHfTokenRefresh(tokenState);

  const backToScan = async (): Promise<void> => {
    if (connectedAddress) {
      await disconnectDevice();
    }
    setTarget(null);
    setScreen('scan');
  };

  const handleSignOut = async (): Promise<void> => {
    // Tear down any in-flight robot connection before dropping the
    // token so the SDK / BLE layer don't keep stale auth in memory.
    logger.info('signout.start');
    if (connectedAddress) {
      await disconnectDevice();
    }
    setTarget(null);
    setScreen('scan');
    clear();
    logger.info('signout.complete');
  };

  // Auth gate: no token => sign-in is the whole UI.
  if (!token) {
    return (
      <Box
        sx={{
          width: '100vw',
          height: '100vh',
          bgcolor: 'background.default',
          color: 'text.primary',
          overflow: 'hidden',
        }}
      >
        <RemoteSignInScreen
          onSignedIn={(result) => {
            setToken(result.token, {
              username: result.username,
              refreshToken: result.refreshToken,
              expiresInSec: result.expiresInSec,
            });
            setScreen('scan');
          }}
        />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        width: '100vw',
        height: '100vh',
        bgcolor: 'background.default',
        color: 'text.primary',
        overflow: 'hidden',
      }}
    >
      {screen === 'scan' && (
        <ScanScreen
          token={token}
          username={username}
          onRobotPicked={(device) => {
            setTarget({ kind: 'local', device });
            setScreen('session');
          }}
          onRemotePicked={(robot) => {
            setTarget({ kind: 'remote', robot });
            setScreen('session');
          }}
          onSignOutRemote={() => void handleSignOut()}
        />
      )}
      {screen === 'session' && target && (
        <RobotSessionScreen
          target={target}
          username={username}
          onBack={() => void backToScan()}
          onNeedsWifi={() => setScreen('wifi-setup')}
        />
      )}
      {screen === 'wifi-setup' && (
        <WifiSetupScreen
          onBack={() => void backToScan()}
          onConnected={() => setScreen('session')}
        />
      )}
    </Box>
  );
}
