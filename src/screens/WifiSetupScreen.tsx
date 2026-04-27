/**
 * Screen 3 - first-time WiFi provisioning over BLE.
 *
 * Visible phases:
 *   - PIN idle          - user enters the 5-digit pin, Back visible.
 *   - PIN auth running  - input disabled, Back hidden, spinner.
 *   - PIN rejected      - inline error + "Try again".
 *   - Picker idle       - NetworkSelect + password + Connect.
 *   - Connecting        - FULL-SCREEN rocket takeover, no Back, no controls.
 *   - Connect failed    - inline error + "Try again".
 *
 * Visual structure (mirrors desktop `FirstTimeWifiSetupView`):
 *   Stepper (Authenticate · Network · Connect)
 *   Hero illustration per phase
 *   Title + subtitle, centred
 *   Form / feedback block (max-width 420px, centred)
 *
 * Auto-advance: once the robot reports `mode=wlan` AND the phone can
 * HTTP-reach the daemon at its new IP, we call `onConnected()`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ReplayIcon from '@mui/icons-material/Replay';
import WifiIcon from '@mui/icons-material/Wifi';

import HeroIllustration from '../components/HeroIllustration';
import NameRobotPanel from '../components/NameRobotPanel';
import NetworkSelect from '../components/NetworkSelect';
import StepperHeader from '../components/StepperHeader';
import { useBleSession } from '../ble/useBleSession';
import { daemonFetch } from '../daemon/daemonFetch';
import { getRobotNameOverLan } from '../daemon/daemonRobotName';
import { shouldPromptRobotName } from '../daemon/robotName';
import { useWifiSetup } from '../wifi/useWifiSetup';
import blueprintSvg from '../assets/blueprint.svg';
import connectionLostSvg from '../assets/connection-lost.svg';
import lockedReachySvg from '../assets/locked-reachy.svg';
import rocketSvg from '../assets/rocket.svg';
import { FONT_WEIGHT, LAYOUT, STATUS, TYPO } from '../styles/tokens';

interface WifiSetupScreenProps {
  onBack: () => void;
  onConnected: () => void;
}

const STEP_LABELS: readonly string[] = ['Authenticate', 'Network', 'Connect'];

/** Poll HTTP daemon at this interval once the robot reports it joined the WiFi. */
const POST_CONNECT_PROBE_MS = 2_000;
/**
 * Grace period during which we silently wait for HTTP reachability once
 * the robot reports `mode=wlan`. After that, we assume the phone is not
 * on the same network and start nudging the user to switch.
 */
const SWITCH_PHONE_HINT_MS = 15_000;
/**
 * How long we wait for the robot to either join (`mode=wlan`) or fall
 * back to hotspot after `WIFI_CONNECT`. After that we label the attempt
 * as failed and send the user back to the picker.
 */
const JOIN_WATCHDOG_MS = 45_000;

type Phase =
  | 'pin-idle'
  | 'pin-running'
  | 'pin-failed'
  | 'picker-idle'
  | 'connecting'
  | 'connect-failed'
  // After the HTTP probe succeeds, we surface a mandatory naming prompt
  // when the robot is still labelled with the daemon default. Picking a
  // name here lets the rest of the app disambiguate this Reachy from any
  // sibling that lives in the same fleet.
  | 'naming';

type ConnectingSubstate =
  | 'sending' // waiting for BLE WIFI_CONNECT ack
  | 'joining' // ack received, robot is trying to join
  | 'joined-probing' // robot says wlan+ssid, probing HTTP
  | 'joined-switch-phone' // robot says wlan+ssid, probe failing for >15s
  | 'fallback-hotspot'; // robot gave up and reopened its hotspot = wrong password

export default function WifiSetupScreen({ onBack, onConnected }: WifiSetupScreenProps) {
  const {
    selectedDevice,
    connectedAddress,
    disconnectDevice,
    readNetworkStatus,
    status: sessionStatus,
  } = useBleSession();
  const setup = useWifiSetup();

  const robotName = selectedDevice?.name ?? 'Reachy Mini';

  const [pinError, setPinError] = useState<string | null>(null);
  const [connectTarget, setConnectTarget] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  /** Timestamp (ms) when the current connect attempt started. Used to
   *  drive grace-period / watchdog logic in the takeover. */
  const [connectStartedAt, setConnectStartedAt] = useState<number | null>(null);
  /** HTTP probe outcome while we wait for the phone to be on the same LAN. */
  const [probeFailedAt, setProbeFailedAt] = useState<number | null>(null);
  /** Tick every 500ms during connect so the takeover re-renders and
   *  transitions through sub-states even when `setup.status` stays
   *  identical. Only active during `connectTarget !== null`. */
  const [, setNowTick] = useState(0);
  /**
   * IP the HTTP probe successfully reached. When non-null, we are past
   * the WiFi-join phase: the daemon is alive on this address and the
   * naming gate is mounted (or about to be).
   */
  const [namingHost, setNamingHost] = useState<string | null>(null);
  /** Initial value for the naming input, sourced from `GET robot-name`. */
  const [namingInitial, setNamingInitial] = useState<string>('');

  // Fallback to scan screen if BLE session dropped.
  useEffect(() => {
    if (!connectedAddress && sessionStatus !== 'connecting') {
      onBack();
    }
  }, [connectedAddress, sessionStatus, onBack]);

  const wlanConnectedToTarget =
    connectTarget !== null &&
    setup.status?.mode === 'wlan' &&
    typeof setup.status.connected === 'string' &&
    setup.status.connected.trim().length > 0 &&
    setup.status.connected.toLowerCase() !== 'hotspot' &&
    (connectTarget === null ||
      setup.status.connected.toLowerCase() === connectTarget.toLowerCase());

  // Tick while a connect attempt is in-flight so sub-state transitions
  // (sending -> joining -> joined-probing -> joined-switch-phone) fire
  // even when the underlying BLE status hasn't changed yet.
  useEffect(() => {
    if (connectTarget === null) return;
    const id = window.setInterval(() => setNowTick(v => v + 1), 500);
    return () => window.clearInterval(id);
  }, [connectTarget]);

  // HTTP probe loop: runs once the robot reports `mode=wlan` on the
  // target SSID. If it succeeds we auto-advance. If it keeps failing the
  // takeover will switch to the "please switch your phone's WiFi" hint
  // after SWITCH_PHONE_HINT_MS, but we never bail out on our own - the
  // user decides when to go back.
  const doneRef = useRef(false);
  useEffect(() => {
    if (!wlanConnectedToTarget) return;
    if (doneRef.current) return;
    let cancelled = false;

    const probe = async (): Promise<string | null> => {
      try {
        const ns = await readNetworkStatus();
        if (cancelled || !ns.ip) return null;
        const resp = await daemonFetch(ns.ip, '/api/daemon/status', { timeoutMs: 4_000 });
        return resp.ok ? ns.ip : null;
      } catch {
        return null;
      }
    };

    const tick = async (): Promise<void> => {
      if (cancelled || doneRef.current) return;
      const reachableIp = await probe();
      if (cancelled) return;
      if (reachableIp !== null) {
        doneRef.current = true;
        // The daemon is up. Read its current name and either route the
        // user through the mandatory naming prompt (when the robot is
        // still on the default label) or short-circuit to onConnected.
        // Failure to read the name is non-fatal - we surface the prompt
        // anyway so the user can set one, with a sensible empty default.
        const info = await getRobotNameOverLan(reachableIp).catch(() => null);
        if (cancelled) return;
        const mustPrompt =
          info === null ||
          shouldPromptRobotName({ name: info.name, source: info.source });
        if (mustPrompt) {
          setNamingHost(reachableIp);
          // Pre-fill with whatever the daemon currently advertises, but
          // blank out the literal default so the user starts on a fresh
          // empty input - typing a few characters feels nicer than
          // editing "reachy_mini" by hand.
          setNamingInitial(info && info.name !== 'reachy_mini' ? info.name : '');
        } else {
          onConnected();
        }
        return;
      }
      setProbeFailedAt(prev => prev ?? Date.now());
    };

    void tick();
    const handle = window.setInterval(() => void tick(), POST_CONNECT_PROBE_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [wlanConnectedToTarget, readNetworkStatus, onConnected]);

  const resetConnectState = (): void => {
    setConnectTarget(null);
    setConnectError(null);
    setConnectStartedAt(null);
    setProbeFailedAt(null);
    doneRef.current = false;
  };

  const handleBack = async (): Promise<void> => {
    resetConnectState();
    await disconnectDevice();
    onBack();
  };

  const handlePinSubmit = async (pin: string): Promise<void> => {
    setPinError(null);
    const ok = await setup.authenticate(pin);
    if (!ok) {
      setPinError(setup.error ?? 'Wrong PIN. Check your robot and try again.');
    }
  };

  const handleConnectSubmit = async (ssid: string, psk: string): Promise<void> => {
    setConnectError(null);
    setConnectTarget(ssid);
    setConnectStartedAt(Date.now());
    setProbeFailedAt(null);
    doneRef.current = false;

    const ok = await setup.connect(ssid, psk);
    if (!ok) {
      setConnectError(
        setup.error ??
          "The robot rejected the credentials. Check the password and try again."
      );
    }
    // If ok, the BLE status polling and HTTP probe loops above take over.
  };

  const handleConnectRetry = (): void => {
    resetConnectState();
  };

  const handleTryAnotherNetwork = (): void => {
    // User acknowledged the hotspot-fallback: go back to picker with a
    // fresh scan.
    resetConnectState();
    void setup.scan();
  };

  const phase: Phase = useMemo(() => {
    if (!setup.isAuthenticated) {
      if (setup.isBusy) return 'pin-running';
      if (pinError) return 'pin-failed';
      return 'pin-idle';
    }
    if (namingHost !== null) return 'naming';
    if (connectTarget && connectError) return 'connect-failed';
    if (connectTarget) return 'connecting';
    return 'picker-idle';
  }, [
    setup.isAuthenticated,
    setup.isBusy,
    pinError,
    connectTarget,
    connectError,
    namingHost,
  ]);

  // Derive the sub-state of the "connecting" takeover from live BLE data.
  const connectingSub: ConnectingSubstate | null = useMemo(() => {
    if (phase !== 'connecting') return null;
    if (setup.isBusy && connectStartedAt !== null) return 'sending';

    // Robot reports it joined our target SSID.
    if (wlanConnectedToTarget) {
      if (probeFailedAt !== null && Date.now() - probeFailedAt > SWITCH_PHONE_HINT_MS) {
        return 'joined-switch-phone';
      }
      return 'joined-probing';
    }

    // Robot went back to hotspot after we sent the creds = probable
    // wrong password / unreachable SSID. Only trust this verdict if the
    // status reports `mode=hotspot` AND we've given the daemon time to
    // try joining.
    const elapsed = connectStartedAt !== null ? Date.now() - connectStartedAt : 0;
    if (
      setup.status?.mode === 'hotspot' &&
      elapsed > 8_000 &&
      !setup.isBusy
    ) {
      return 'fallback-hotspot';
    }

    // Watchdog: nothing interesting happened for 45s.
    if (elapsed > JOIN_WATCHDOG_MS) {
      return 'fallback-hotspot';
    }

    return 'joining';
  }, [
    phase,
    setup.isBusy,
    setup.status?.mode,
    connectStartedAt,
    wlanConnectedToTarget,
    probeFailedAt,
  ]);

  if (phase === 'connecting' && connectingSub !== null) {
    return (
      <ConnectingTakeover
        ssid={connectTarget ?? 'your network'}
        substate={connectingSub}
        wifiError={setup.status?.error ?? null}
        onRetryProbe={() => setProbeFailedAt(Date.now() - SWITCH_PHONE_HINT_MS - 1_000)}
        onTryAnotherNetwork={handleTryAnotherNetwork}
        onBackToScan={() => void handleBack()}
      />
    );
  }

  if (phase === 'naming' && namingHost !== null) {
    return (
      <Stack
        sx={{
          height: '100%',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          px: 3,
          pt: LAYOUT.safeAreaTop,
          pb: 4,
        }}
      >
        <NameRobotPanel
          host={namingHost}
          initialName={namingInitial}
          subtitle="Pick a short name (1-32 characters) so this Reachy is easy to recognise in your fleet. You can also skip and rename it later from Settings."
          onSaved={() => onConnected()}
          onSkip={() => onConnected()}
        />
      </Stack>
    );
  }

  const showBack = phase !== 'pin-running';
  const stepperIdx = stepperIndexFor(phase);
  const stepperError = phase === 'pin-failed' || phase === 'connect-failed';
  const heroSrc = heroForPhase(phase);

  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        position: 'relative',
        alignItems: 'center',
        justifyContent: 'flex-start',
        px: 3,
        pt: LAYOUT.safeAreaTop,
        pb: 4,
      }}
    >
      {showBack && (
        <Box sx={{ position: 'absolute', top: 48, left: 12 }}>
          <IconButton size="small" onClick={() => void handleBack()} aria-label="Back">
            <ArrowBackIosNewIcon fontSize="small" />
          </IconButton>
        </Box>
      )}

      <Stack
        spacing={2}
        alignItems="center"
        sx={{
          width: '100%',
          maxWidth: LAYOUT.contentMaxWidth,
          flex: 1,
          justifyContent: 'center',
        }}
      >
        <Box sx={{ width: '100%', px: 1 }}>
          <StepperHeader
            steps={STEP_LABELS}
            activeStep={stepperIdx}
            error={stepperError}
          />
        </Box>

        <HeroIllustration
          src={heroSrc}
          alt={titleFor(phase)}
          animation="float"
          size={LAYOUT.heroSizeSmall}
          mb={0.5}
        />

        <Stack spacing={0.5} alignItems="center" sx={{ width: '100%', px: 1 }}>
          <Typography
            sx={{
              fontSize: TYPO.xl,
              fontWeight: FONT_WEIGHT.semibold,
              color: 'text.primary',
              textAlign: 'center',
              letterSpacing: '-0.2px',
            }}
          >
            {titleFor(phase)}
          </Typography>
          <Typography
            sx={{
              fontSize: TYPO.md,
              color: 'text.secondary',
              textAlign: 'center',
              lineHeight: 1.5,
              maxWidth: 320,
            }}
          >
            {subtitleFor(phase, robotName, connectTarget)}
          </Typography>
        </Stack>

        <Box sx={{ width: '100%', mt: 1 }}>
          {phase === 'pin-idle' || phase === 'pin-running' || phase === 'pin-failed' ? (
            <PinStep busy={setup.isBusy} error={pinError} onSubmit={handlePinSubmit} />
          ) : phase === 'picker-idle' ? (
            <PickerStep
              busy={setup.isBusy}
              scanResults={setup.scanResults}
              connectedSsid={setup.status?.connected ?? null}
              onScan={setup.scan}
              onConnect={handleConnectSubmit}
            />
          ) : phase === 'connect-failed' ? (
            <ConnectFailedStep
              ssid={connectTarget ?? ''}
              error={connectError ?? ''}
              onTryAgain={handleConnectRetry}
            />
          ) : null}
        </Box>
      </Stack>
    </Stack>
  );
}

/* --- Phase helpers ---------------------------------------------------- */

function stepperIndexFor(phase: Phase): number {
  switch (phase) {
    case 'pin-idle':
    case 'pin-running':
    case 'pin-failed':
      return 0;
    case 'picker-idle':
      return 1;
    // ``naming`` shares step 2 with connect: from the user's perspective
    // it's still the "join the network" leg of the flow. The naming UI
    // takes over the whole screen so the stepper itself isn't visible
    // there - this case only exists to keep the switch exhaustive.
    case 'connecting':
    case 'connect-failed':
    case 'naming':
      return 2;
  }
}

function heroForPhase(phase: Phase): string {
  switch (phase) {
    case 'pin-idle':
    case 'pin-running':
      return lockedReachySvg;
    case 'pin-failed':
      return connectionLostSvg;
    case 'picker-idle':
      return blueprintSvg;
    case 'connecting':
    case 'naming':
      return rocketSvg;
    case 'connect-failed':
      return connectionLostSvg;
  }
}

function titleFor(phase: Phase): string {
  switch (phase) {
    case 'pin-idle':
    case 'pin-running':
      return 'Set up WiFi';
    case 'pin-failed':
      return 'Wrong PIN';
    case 'picker-idle':
      return 'Choose a WiFi';
    case 'connecting':
    case 'naming':
      return '';
    case 'connect-failed':
      return "Couldn't join";
  }
}

function subtitleFor(phase: Phase, robotName: string, target: string | null): string {
  switch (phase) {
    case 'pin-idle':
    case 'pin-running':
      return `Enter the PIN shown on ${robotName}.`;
    case 'pin-failed':
      return 'Check the PIN on the robot and try again.';
    case 'picker-idle':
      return 'Pick a network the robot can reach.';
    case 'connecting':
    case 'naming':
      return '';
    case 'connect-failed':
      return target ? `We couldn't join "${target}".` : '';
  }
}

/* --- PIN step --------------------------------------------------------- */

function PinStep({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState('');
  const clean = pin.replace(/\D/g, '').slice(0, 5);
  const canSubmit = !busy && clean.length >= 4;

  useEffect(() => {
    if (error) setPin('');
  }, [error]);

  return (
    <Stack spacing={2.5} alignItems="stretch">
      {error && (
        <Typography
          sx={{ fontSize: TYPO.sm, color: STATUS.error, textAlign: 'center' }}
        >
          {error}
        </Typography>
      )}

      <TextField
        label="PIN"
        value={clean}
        onChange={e => setPin(e.target.value)}
        inputProps={{
          inputMode: 'numeric',
          pattern: '[0-9]*',
          autoComplete: 'off',
          maxLength: 5,
          style: {
            fontSize: '1.6rem',
            letterSpacing: '0.5em',
            textAlign: 'center',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          },
        }}
        autoFocus
        disabled={busy}
        fullWidth
      />

      {busy ? (
        <Stack
          direction="row"
          alignItems="center"
          spacing={1.5}
          justifyContent="center"
          sx={{ py: 1 }}
        >
          <CircularProgress size={18} />
          <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
            Authenticating…
          </Typography>
        </Stack>
      ) : (
        <Button
          variant="contained"
          size="large"
          disabled={!canSubmit}
          onClick={() => void onSubmit(clean)}
          sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 600 }}
        >
          {error ? 'Try again' : 'Continue'}
        </Button>
      )}
    </Stack>
  );
}

/* --- Picker step ------------------------------------------------------ */

function PickerStep({
  busy,
  scanResults,
  connectedSsid,
  onScan,
  onConnect,
}: {
  busy: boolean;
  scanResults: string[];
  connectedSsid: string | null;
  onScan: () => Promise<string[]>;
  onConnect: (ssid: string, psk: string) => Promise<void>;
}) {
  const [selectedSsid, setSelectedSsid] = useState('');
  const [manualSsid, setManualSsid] = useState('');
  const [psk, setPsk] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const scannedRef = useRef(false);

  useEffect(() => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    void onScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ssidToConnect = selectedSsid || manualSsid.trim();
  const canConnect = !busy && ssidToConnect.length > 0;

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Box sx={{ flex: 1 }}>
          <NetworkSelect
            value={selectedSsid}
            onChange={ssid => {
              setSelectedSsid(ssid);
              setManualSsid('');
            }}
            networks={scanResults}
            isLoading={busy}
            connectedNetwork={connectedSsid}
            disabled={busy && scanResults.length === 0}
          />
        </Box>
        <IconButton
          onClick={() => void onScan()}
          disabled={busy}
          size="small"
          aria-label="Rescan"
          sx={{
            border: theme => `1px solid ${theme.palette.divider}`,
            borderRadius: 1.5,
            height: 40,
            width: 40,
          }}
        >
          {busy ? <CircularProgress size={14} thickness={5} /> : <ReplayIcon fontSize="small" />}
        </IconButton>
      </Stack>

      <TextField
        label="Password"
        value={psk}
        onChange={e => setPsk(e.target.value)}
        type="password"
        autoComplete="new-password"
        fullWidth
        disabled={busy}
      />

      {!showHidden ? (
        <Button
          size="small"
          variant="text"
          color="inherit"
          onClick={() => setShowHidden(true)}
          sx={{ alignSelf: 'center', opacity: 0.7, textTransform: 'none' }}
        >
          Hidden network? Type SSID ›
        </Button>
      ) : (
        <TextField
          label="SSID (hidden network)"
          value={manualSsid}
          onChange={e => {
            setSelectedSsid('');
            setManualSsid(e.target.value);
          }}
          size="small"
          fullWidth
          disabled={busy}
        />
      )}

      <Button
        variant="contained"
        size="large"
        disabled={!canConnect}
        onClick={() => void onConnect(ssidToConnect, psk)}
        startIcon={<WifiIcon />}
        sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 600 }}
      >
        Connect
      </Button>
    </Stack>
  );
}

/* --- Connect failed --------------------------------------------------- */

function ConnectFailedStep({
  ssid,
  error,
  onTryAgain,
}: {
  ssid: string;
  error: string;
  onTryAgain: () => void;
}) {
  return (
    <Stack spacing={2} alignItems="stretch">
      <Typography
        sx={{ fontSize: TYPO.sm, color: STATUS.error, textAlign: 'center' }}
      >
        {error}
      </Typography>
      {ssid && (
        <Typography
          sx={{
            fontSize: TYPO.xs,
            color: 'text.secondary',
            fontFamily: 'monospace',
            textAlign: 'center',
          }}
        >
          Target: {ssid}
        </Typography>
      )}

      <Button
        variant="contained"
        size="large"
        onClick={onTryAgain}
        startIcon={<ReplayIcon />}
        sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 600 }}
      >
        Try again
      </Button>
    </Stack>
  );
}

/* --- Connecting takeover --------------------------------------------- */

interface ConnectingTakeoverProps {
  ssid: string;
  substate: ConnectingSubstate;
  /** `setup.status.error` as reported by the daemon, when available. */
  wifiError: string | null;
  /** Force an immediate HTTP probe (used by the "switch phone" hint). */
  onRetryProbe: () => void;
  /** User acknowledges the robot fell back to hotspot; go back to the
   *  picker with a fresh scan. */
  onTryAnotherNetwork: () => void;
  /** Hard exit: drop the BLE session and go back to the scan screen. */
  onBackToScan: () => void;
}

/**
 * Fullscreen takeover covering the entire "connecting" phase.
 *
 * Never reports "failed" to the user if the robot actually joined. The
 * possible outcomes are:
 *
 *  - success (handled by the parent via `onConnected`)
 *  - `fallback-hotspot` - robot came back to hotspot => bad password,
 *     user is nudged to pick another network.
 *  - the user manually gave up and tapped "Back to scan".
 */
function ConnectingTakeover({
  ssid,
  substate,
  wifiError,
  onRetryProbe,
  onTryAnotherNetwork,
  onBackToScan,
}: ConnectingTakeoverProps) {
  const isWorking =
    substate === 'sending' || substate === 'joining' || substate === 'joined-probing';
  const heroSrc = substate === 'fallback-hotspot' ? connectionLostSvg : rocketSvg;
  const heroAnim: 'float' | 'pulse' = isWorking ? 'pulse' : 'float';

  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        position: 'relative',
        alignItems: 'center',
        justifyContent: 'center',
        px: 4,
        pt: LAYOUT.safeAreaTop,
        pb: 3,
      }}
      spacing={2.5}
    >
      <HeroIllustration
        src={heroSrc}
        alt={ssid}
        animation={heroAnim}
        size={LAYOUT.heroSize}
        mb={0}
      />

      <Stack
        spacing={0.5}
        alignItems="center"
        sx={{ textAlign: 'center', maxWidth: 360 }}
      >
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
          {headerLabelFor(substate)}
        </Typography>
        <Typography
          sx={{
            fontSize: TYPO.hero,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.primary',
            letterSpacing: '-0.3px',
          }}
          noWrap
        >
          {ssid}
        </Typography>
      </Stack>

      <ConnectingSubstatusBlock substate={substate} wifiError={wifiError} />

      <ConnectingActions
        substate={substate}
        onRetryProbe={onRetryProbe}
        onTryAnotherNetwork={onTryAnotherNetwork}
        onBackToScan={onBackToScan}
      />
    </Stack>
  );
}

function headerLabelFor(substate: ConnectingSubstate): string {
  switch (substate) {
    case 'sending':
      return 'Sending credentials to';
    case 'joining':
      return 'Robot is joining';
    case 'joined-probing':
      return 'Connected to';
    case 'joined-switch-phone':
      return 'Robot is on';
    case 'fallback-hotspot':
      return "Couldn't join";
  }
}

function ConnectingSubstatusBlock({
  substate,
  wifiError,
}: {
  substate: ConnectingSubstate;
  wifiError: string | null;
}) {
  if (substate === 'sending' || substate === 'joining') {
    return (
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minHeight: 40 }}>
        <CircularProgress size={16} thickness={4} />
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
          {substate === 'sending'
            ? 'Transferring over Bluetooth…'
            : 'Waiting for the robot to connect…'}
        </Typography>
      </Stack>
    );
  }

  if (substate === 'joined-probing') {
    return (
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        sx={{
          minHeight: 40,
          px: 2,
          py: 1,
          borderRadius: 2,
          bgcolor: 'action.hover',
        }}
      >
        <CheckRoundedIcon sx={{ fontSize: 18, color: STATUS.success }} />
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
          Robot joined the network. Checking reachability…
        </Typography>
      </Stack>
    );
  }

  if (substate === 'joined-switch-phone') {
    return (
      <Stack
        spacing={1.25}
        alignItems="center"
        sx={{ maxWidth: 340, textAlign: 'center' }}
      >
        <Typography sx={{ fontSize: TYPO.md, color: 'text.primary', fontWeight: FONT_WEIGHT.semibold }}>
          Almost there
        </Typography>
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', lineHeight: 1.5 }}>
          The robot is online but this phone can&apos;t reach it yet. Make sure your
          phone is on the same WiFi network, then tap <strong>Retry</strong>.
        </Typography>
      </Stack>
    );
  }

  if (substate === 'fallback-hotspot') {
    return (
      <Stack
        spacing={1}
        alignItems="center"
        sx={{ maxWidth: 340, textAlign: 'center' }}
      >
        <Typography sx={{ fontSize: TYPO.sm, color: STATUS.error }}>
          {wifiError || 'The robot reopened its hotspot.'}
        </Typography>
        <Typography sx={{ fontSize: TYPO.xs, color: 'text.disabled', lineHeight: 1.5 }}>
          Most of the time this means the password was wrong or the network was out
          of range.
        </Typography>
      </Stack>
    );
  }

  return null;
}

function ConnectingActions({
  substate,
  onRetryProbe,
  onTryAnotherNetwork,
  onBackToScan,
}: {
  substate: ConnectingSubstate;
  onRetryProbe: () => void;
  onTryAnotherNetwork: () => void;
  onBackToScan: () => void;
}) {
  if (substate === 'sending' || substate === 'joining' || substate === 'joined-probing') {
    return (
      <Box sx={{ position: 'absolute', bottom: 24, left: 0, right: 0, textAlign: 'center' }}>
        <Link
          component="button"
          onClick={onBackToScan}
          underline="hover"
          sx={{ fontSize: TYPO.xs, color: 'text.disabled' }}
        >
          Cancel and go back
        </Link>
      </Box>
    );
  }

  if (substate === 'joined-switch-phone') {
    return (
      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 320 }}>
        <Button
          variant="contained"
          size="large"
          startIcon={<ReplayIcon />}
          onClick={onRetryProbe}
          sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 600 }}
        >
          I&apos;m on the same WiFi - Retry
        </Button>
        <Button
          variant="text"
          onClick={onBackToScan}
          sx={{ textTransform: 'none' }}
        >
          Back to scan
        </Button>
      </Stack>
    );
  }

  if (substate === 'fallback-hotspot') {
    return (
      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 320 }}>
        <Button
          variant="contained"
          size="large"
          startIcon={<WifiIcon />}
          onClick={onTryAnotherNetwork}
          sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 600 }}
        >
          Try another network
        </Button>
        <Button
          variant="text"
          onClick={onBackToScan}
          sx={{ textTransform: 'none' }}
        >
          Back to scan
        </Button>
      </Stack>
    );
  }

  return null;
}
