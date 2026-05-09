import { useState } from 'react';
import { Box } from '@mui/material';

import ScanScreen from './screens/ScanScreen';
import SplashScreen from './screens/SplashScreen';
import WelcomeBackScreen from './screens/WelcomeBackScreen';
import WifiSetupScreen from './screens/WifiSetupScreen';
import RemoteSignInScreen from './screens/RemoteSignInScreen';
import RobotSessionScreen, {
  type ConnectionTarget,
} from './screens/RobotSessionScreen';
import ScreenTransition from '@/ui/design/ScreenTransition';
import {
  useBleSession,
  useInitBleListeners,
} from './ble/useBleSession';
import { useRemoteHfToken } from './auth/useRemoteHfToken';
import { usePrefetchApps } from './apps/useApps';

type Screen = 'scan' | 'session' | 'wifi-setup';

/**
 * Root component.
 *
 * Auth gate
 * ─────────
 * Hugging Face sign-in is the entry point of the app: while no token
 * is present we render `RemoteSignInScreen` full-screen. Once signed
 * in the rest of the app boots, starting on the unified discovery
 * view. Sign-out clears the token, which immediately collapses
 * everything back to the gate.
 *
 * Three discovery sources, one connection path
 * ────────────────────────────────────────────
 * `ScanScreen` exposes three sections (Local USB / Wi-Fi BLE /
 * Distant Central). For the minimal app, only the Distant section
 * is connectable: the SDK signals through the central HF Space and
 * negotiates a single WebRTC + DataChannel session. Wi-Fi BLE rows
 * route into `WifiSetupScreen` for first-time provisioning. Local
 * USB is a placeholder until the daemon ships a loopback signaling
 * endpoint.
 */
export default function App() {
  // Brand splash shown for ~1.2 s on every cold start, fading out
  // before the auth gate. Sits in front of the OS's native launch
  // screen (iOS LaunchScreen, Android launcher theme) so the brand
  // moment is consistent regardless of WebView warm-up time.
  const [splashDone, setSplashDone] = useState(false);
  const [screen, setScreen] = useState<Screen>('scan');
  const [target, setTarget] = useState<ConnectionTarget | null>(null);
  // True for the ~1.5 s celebratory transition that runs right
  // after the OAuth callback resolves, on top of the freshly-
  // mounted ScanScreen. Lets the data fetch warm up underneath
  // while the user reads "Hello, @username".
  const [justSignedIn, setJustSignedIn] = useState(false);
  const { disconnectDevice, connectedAddress, selectDevice } = useBleSession();
  const { token, username, setToken, clear } = useRemoteHfToken();

  useInitBleListeners();
  // Warm the apps catalog cache as soon as the app boots so the
  // Apps tab opens with the list already in place (no spinner on
  // first visit). The catalog endpoint is public, so it's safe to
  // fetch even before the auth gate. The cache lives for the whole
  // JS session and is naturally refreshed on cold start.
  usePrefetchApps();

  const backToScan = async (): Promise<void> => {
    if (connectedAddress) {
      await disconnectDevice();
    }
    setTarget(null);
    setScreen('scan');
  };

  const handleSignOut = async (): Promise<void> => {
    if (connectedAddress) {
      await disconnectDevice();
    }
    setTarget(null);
    setScreen('scan');
    clear();
  };

  // Brand splash gate: shown once on cold start, before anything
  // else can render. The auth gate / scan screen are mounted only
  // AFTER `onDone` fires so the user always sees the brand moment
  // first, never a flash of the sign-in form before the splash.
  if (!splashDone) {
    return <SplashScreen onDone={() => setSplashDone(true)} />;
  }

  // Auth gate: no token → sign-in is the whole UI.
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
          onSignedIn={(t, u) => {
            setToken(t, u);
            setScreen('scan');
            // Trigger the welcome-back transition. The flag is
            // cleared by the WelcomeBackScreen's `onDone` after
            // its fade-out completes, leaving the user on the
            // (already mounted, already fetching) scan screen.
            setJustSignedIn(true);
          }}
        />
      </Box>
    );
  }

  // Build the active screen content separately so we can hand it
  // off to <ScreenTransition> as the *children* of a single
  // animated wrapper - this is what lets Motion's
  // `AnimatePresence` track enter/exit per screen via the
  // `screenKey` prop. Each branch returns a fully-formed root
  // node so swapping screens never produces an undefined render.
  const currentScreen = (() => {
    if (screen === 'session' && target) {
      return (
        <RobotSessionScreen
          target={target}
          token={token}
          username={username}
          onBack={() => void backToScan()}
        />
      );
    }
    if (screen === 'wifi-setup') {
      return (
        <WifiSetupScreen onBack={() => void backToScan()} token={token} />
      );
    }
    // `scan` is the default landing screen - we fall through here
    // even when `screen === 'session'` but `target` is null
    // (defensive: should never happen, but renders a sane view).
    return (
      <ScanScreen
        token={token}
        username={username}
        onRobotPicked={(device) => {
          // Stash the picked BLE device in the store BEFORE we
          // navigate so `WifiSetupScreen` reads a non-null
          // `selectedDevice` on first render. Without this, the
          // setup screen lands on its `failed` phase with a
          // misleading "No robot selected" message - the user has
          // to tap "Try again" to actually reach the PIN flow.
          selectDevice(device);
          setScreen('wifi-setup');
        }}
        onRemotePicked={(robot) => {
          setTarget({ kind: 'remote', robot });
          setScreen('session');
        }}
        onSignOutRemote={() => void handleSignOut()}
      />
    );
  })();

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
      <ScreenTransition screenKey={screen}>{currentScreen}</ScreenTransition>

      {/* Post-sign-in welcome overlay. Sits at the modal layer
          above whichever screen is currently mounted (always
          ScanScreen in practice, since the OAuth callback always
          lands on `screen === 'scan'`) and dismisses itself
          after a short visible window. The screen behind it is
          already kicking off `useRemoteRobots`, so by the time
          the welcome fades out the list is usually populated. */}
      {justSignedIn && (
        <WelcomeBackScreen
          username={username}
          onDone={() => setJustSignedIn(false)}
        />
      )}
    </Box>
  );
}
