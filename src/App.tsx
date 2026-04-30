import { useEffect, useState } from 'react';
import { Box } from '@mui/material';

import PermissionsScreen from './screens/PermissionsScreen';
import ScanScreen from './screens/ScanScreen';
import WifiSetupScreen from './screens/WifiSetupScreen';
import RemoteSignInScreen from './screens/RemoteSignInScreen';
import RobotSessionScreen, {
  type ConnectionTarget,
} from './screens/RobotSessionScreen';
import SplashScreen from './screens/SplashScreen';
import {
  useBleSession,
  useInitBleListeners,
} from './ble/useBleSession';
import { useHfTokenRefresh } from './auth/useHfTokenRefresh';
import { useRemoteHfToken } from './auth/useRemoteHfToken';
import { unlockIosMicForWebRtc } from './permissions/iosMicUnlock';
import { usePermissionsBootstrap } from './permissions/usePermissionsBootstrap';
import type { AggregatedRobot } from './presence/aggregatedRobot';
import { needsWifiSetup } from './presence/needsWifiSetup';
import { pickBestTarget } from './presence/pickBestTarget';
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
  const [splashDone, setSplashDone] = useState(false);
  const [screen, setScreen] = useState<Screen>('scan');
  const [target, setTarget] = useState<ConnectionTarget | null>(null);
  const { disconnectDevice, connectedAddress, connectToDevice } = useBleSession();
  const tokenState = useRemoteHfToken();
  const { token, username, setToken, clear } = tokenState;
  const permissions = usePermissionsBootstrap();

  useInitBleListeners();
  // Auto-refresh the HF access token in the background. When HF
  // doesn't issue a refresh token (depending on client config) this
  // is a no-op and the user re-auths on next 401 instead.
  useHfTokenRefresh(tokenState);

  // Defensive iOS LAN-candidate unlock for users who already passed
  // the up-front PermissionsScreen on a previous launch. The screen
  // is the preferred path (real user-gesture frame, idempotent
  // localStorage flag) but if iOS WKWebView decided to drop our
  // permission grant for any reason we still want to reattempt the
  // unlock on every cold start. This mirrors what doConnect()
  // already does, but earlier in the lifecycle so the SDK's
  // ICE-gathering kicks off with the LAN candidates available.
  useEffect(() => {
    if (!permissions.bootstrapped) return;
    void unlockIosMicForWebRtc().catch(() => {
      // Denied or unavailable. doConnect() will try once more
      // when the user actually picks a robot.
    });
    logger.info('boot.app_root_mounted', {
      bootstrapped: permissions.bootstrapped,
      has_token: Boolean(token),
    });
  }, [permissions.bootstrapped, token]);

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

  // Splash takes over until its own fade-out completes; auth gate and
  // main UI only mount once it's gone so the first paint is the brand.
  if (!splashDone) {
    return <SplashScreen onDone={() => setSplashDone(true)} />;
  }

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

  // Permissions gate: shown once on first launch (or after a manual
  // reset). Drives the iOS prompts in a user-gesture frame, before
  // any robot interaction — see PermissionsScreen for the rationale.
  if (!permissions.bootstrapped) {
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
        <PermissionsScreen onDone={permissions.markBootstrapped} />
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
          onRobotPicked={(robot: AggregatedRobot) => {
            // Setup-first short-circuit: when the BLE TLV says the
            // robot is in `hotspot` or `offline`, there's no daemon
            // to handshake with - going through RobotSessionScreen
            // would just produce a "Set up Wi-Fi?" failure flash
            // before landing here anyway. Skip straight to the
            // provisioning flow. See `needsWifiSetup.ts` for the
            // exact rules.
            //
            // We start the BLE connect ourselves before navigating.
            // WifiSetupScreen bails out if it sees `connectedAddress
            // === null && status !== 'connecting'`, so the connect has
            // to be in flight by the time the screen mounts. Awaiting
            // until the BLE store has flipped to 'connecting' is
            // enough; the screen then drives the rest of the
            // lifecycle (PIN auth, scan, connect to Wi-Fi).
            if (needsWifiSetup(robot)) {
              const bleTransport = robot.transports.find(t => t.type === 'ble');
              if (!bleTransport || bleTransport.type !== 'ble') {
                logger.warn('scan.wifi_setup_no_ble', { key: robot.key });
                return;
              }
              logger.info('scan.target_picked', {
                key: robot.key,
                kind: 'wifi-setup',
                reason: 'network_mode_not_connected',
              });
              setTarget(null);
              // Fire-and-forget: the BLE store flips synchronously
              // to selectedDevice + status='connecting' on the first
              // microtask, which is before WifiSetupScreen's mount
              // effect runs. The screen owns the rest.
              void connectToDevice(bleTransport.device);
              setScreen('wifi-setup');
              return;
            }

            // The aggregator already fused all transports for this
            // physical robot - now we let `pickBestTarget` pick the
            // single best one (priority: localhost > BLE > central
            // by default) and convert it to the `ConnectionTarget`
            // shape the session FSM consumes.
            //
            // ⚠️ This is the ONE place in the app that decides which
            // wire to use to talk to a robot. Don't bypass it. The
            // resolver inside `useResolvedPeerId` then handles the
            // identity-to-peerId mapping with strong-id matching;
            // both pieces together close the "BLE robot ⇒ tray
            // daemon" hijack we used to suffer from.
            const next = pickBestTarget(robot);
            if (!next) {
              logger.warn('scan.no_target_resolvable', {
                key: robot.key,
                disabled: robot.disabled,
                transports: robot.transports.map((t) => t.type),
              });
              return;
            }
            logger.info('scan.target_picked', {
              key: robot.key,
              kind: next.kind,
            });
            setTarget(next);
            setScreen('session');
          }}
          onSignOutRemote={() => void handleSignOut()}
        />
      )}
      {screen === 'session' && target && (
        <RobotSessionScreen
          target={target}
          username={username}
          hfToken={token}
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
