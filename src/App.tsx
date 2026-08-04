import { useEffect, useState } from 'react';
import { Box } from '@mui/material';

import EulaConsentModal from '@/ui/screens/EulaConsentModal';
import ScanScreen from '@/ui/screens/ScanScreen';
import SplashScreen from '@/ui/screens/SplashScreen';
import WelcomeBackScreen from '@/ui/screens/WelcomeBackScreen';
import RemoteSignInScreen from '@/ui/screens/RemoteSignInScreen';
import RobotSessionScreen, {
  type ConnectionTarget,
} from '@/ui/screens/RobotSessionScreen';
import SetupWizardScreen from '@/ui/screens/SetupWizardScreen';
import BleUpdateScreen from '@/ui/screens/BleUpdateScreen';
import ScreenTransition from '@/ui/design/ScreenTransition';
import { useRemoteHfToken, isHfTokenExpired } from '@/features/auth/useRemoteHfToken';
import { onHfTokenInvalid } from '@/features/auth/tokenInvalidation';
import { usePrefetchApps } from '@/features/apps/useApps';
import { usePrefetchMyApps } from '@/features/apps/useMyApps';
import { usePrefetchSpaceLikes } from '@/features/apps/useSpaceLikes';
import { useTosConsent } from '@/features/consent/useTosConsent';

type Screen = 'scan' | 'session' | 'setup' | 'ble-update';

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
 * Single discovery path
 * ─────────────────────
 * `ScanScreen` lists the user's robots as advertised by the HF central
 * signaling Space. Tapping a row hands off to `RobotSessionScreen`,
 * which negotiates the SDK's WebRTC + DataChannel session through the
 * same central.
 *
 * First-time setup
 * ────────────────
 * A brand-new Reachy Mini Wireless is not on Wi-Fi yet (and therefore
 * not on central), so it can't appear in the list. The "Set up a new
 * Reachy" CTA on `ScanScreen` opens `SetupWizardScreen`, which provisions
 * the robot's Wi-Fi over Bluetooth (see `docs/FIRST_TIME_SETUP_PLAN.md`).
 * On success the robot registers with central and we either open a
 * session directly or drop the user back on the (now-populated) list.
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
  // True when the user landed on the sign-in gate because their token
  // was rejected/expired (auto-eviction), NOT because they signed out
  // or never signed in. Drives a short "session expired" notice so the
  // sudden bounce to sign-in doesn't read as a random logout.
  const [sessionExpired, setSessionExpired] = useState(false);
  const { token, username, setToken, clear } = useRemoteHfToken();
  // First-launch EULA / privacy disclosure required by Apple
  // guideline 5.1.1 + Google Play UGC policy. The hook reads the
  // accepted version synchronously from localStorage so the modal
  // never flashes on subsequent launches.
  const consent = useTosConsent();

  // Warm the apps catalog cache as soon as the app boots so the
  // Apps tab opens with the list already in place (no spinner on
  // first visit). The catalog endpoint is public, so it's safe to
  // fetch even before the auth gate. The cache lives for the whole
  // JS session and is naturally refreshed on cold start.
  usePrefetchApps();

  // Same warm-up for the "Your apps" rail (the user's own Reachy
  // Spaces on HF, private included). Unifies the boot-time network
  // calls with the catalog above: both lists are fetched once at
  // start and shared via TanStack Query. No-ops while signed out.
  usePrefetchMyApps();

  // And the user's liked-Spaces set, so the hearts on the Apps tab
  // are already filled in on first paint instead of hydrating only
  // when the apps panel mounts. Same boot-time pattern as the two
  // prefetches above; no-ops while signed out.
  usePrefetchSpaceLikes();

  const backToScan = (): void => {
    setTarget(null);
    setScreen('scan');
  };

  const handleSignOut = (): void => {
    setTarget(null);
    setScreen('scan');
    // Deliberate sign-out: no "session expired" notice on the gate.
    setSessionExpired(false);
    clear();
  };

  // Hard auth recovery. Direct HF calls (router chat/vision) emit a
  // token-invalid signal when Hugging Face returns 401 - a token that
  // still looks valid locally (future `exp`, or opaque so `exp` is
  // unreadable) but whose signature no longer verifies. The `exp`-only
  // gate below can't catch that, so it would 401 forever with no way
  // out. Clearing the token here collapses the app back to the sign-in
  // gate so the user re-auths into a fresh token. Same effect as an
  // explicit sign-out, minus the user's tap.
  useEffect(() => {
    return onHfTokenInvalid(() => {
      setTarget(null);
      setScreen('scan');
      setSessionExpired(true);
      clear();
    });
  }, [clear]);

  // Brand splash gate: shown once on cold start, before anything
  // else can render. The auth gate / scan screen are mounted only
  // AFTER `onDone` fires so the user always sees the brand moment
  // first, never a flash of the sign-in form before the splash.
  if (!splashDone) {
    return <SplashScreen onDone={() => setSplashDone(true)} />;
  }

  // Consent gate: shown ONCE, on first launch (or any time the
  // TOS version is bumped). Sits between splash and auth so the
  // user is told what the app does before they hand over their HF
  // credentials. Subsequent launches read `accepted = true`
  // synchronously and this branch is skipped.
  if (!consent.accepted) {
    return <EulaConsentModal onAccept={consent.accept} />;
  }

  // Auth gate: no token — OR an expired OAuth token — → sign-in is
  // the whole UI. Without the expiry check a stale-but-present token
  // is truthy, so the app silently replays a dead token forever (the
  // far-future SDK stamp hides expiry), 401-ing every direct HF call
  // with no in-app way to recover. Treating an expired token as
  // "needs sign-in" surfaces the OAuth flow so the user re-auths.
  // Gate-only: the SDK's `hf_token_expires` stays far-future, so the
  // central-tolerant connect path is unchanged.
  if (!token || isHfTokenExpired(token)) {
    return (
      <Box
        sx={{
          width: '100vw',
          // `100dvh` follows the dynamic viewport: when the iOS
          // keyboard slides up the layout viewport shrinks, dvh
          // shrinks with it, so our screen never has content
          // poking out below the keyboard. Plain `100vh` would
          // freeze at the initial height and leak the system bg.
          // Array fallback for older WebKits that don't know dvh.
          height: ['100vh', '100dvh'],
          bgcolor: 'background.default',
          color: 'text.primary',
          overflow: 'hidden',
        }}
      >
        <RemoteSignInScreen
          // Show a short notice when we bounced the user here on an
          // expired/rejected token (auto-eviction) or a stored token
          // whose `exp` has lapsed since last launch - never on a
          // deliberate sign-out or a brand-new install (no token).
          expired={sessionExpired || (!!token && isHfTokenExpired(token))}
          onSignedIn={(t, u) => {
            setToken(t, u);
            setScreen('scan');
            setSessionExpired(false);
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
          onBack={backToScan}
        />
      );
    }
    if (screen === 'ble-update') {
      return <BleUpdateScreen onBack={backToScan} />;
    }
    if (screen === 'setup') {
      return (
        <SetupWizardScreen
          token={token}
          onCancel={backToScan}
          onComplete={(result) => {
            // If the freshly-provisioned robot already appeared on
            // central, jump straight into a session with it. Otherwise
            // (Wi-Fi joined but not yet registered) fall back to the
            // list, which keeps polling and will surface it shortly.
            if (result.robot) {
              setTarget({ kind: 'remote', robot: result.robot });
              setScreen('session');
            } else {
              backToScan();
            }
          }}
        />
      );
    }
    // `scan` is the default landing screen - we fall through here
    // even when `screen === 'session'` but `target` is null
    // (defensive: should never happen, but renders a sane view).
    return (
      <ScanScreen
        token={token}
        username={username}
        onRemotePicked={(robot) => {
          setTarget({ kind: 'remote', robot });
          setScreen('session');
        }}
        onStartSetup={() => setScreen('setup')}
        onOpenBleUpdate={() => setScreen('ble-update')}
        onSignOutRemote={handleSignOut}
      />
    );
  })();

  return (
    <Box
      sx={{
        width: '100vw',
        // Same dynamic-viewport rationale as the auth-gate Box
        // above: `100dvh` shrinks with the iOS keyboard so the
        // screen never has a system-bg gap below it. Array
        // fallback to `100vh` for older WebKits.
        height: ['100vh', '100dvh'],
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
