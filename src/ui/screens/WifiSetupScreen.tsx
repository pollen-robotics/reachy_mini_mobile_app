/**
 * Minimal BLE-driven Wi-Fi setup.
 *
 * 100% BLE. No HTTP daemon calls anywhere - status is read from the
 * GATT NETWORK_STATUS characteristic (no PIN) and from the public
 * `WIFI_STATUS` BLE command (also no PIN). Provisioning is the same
 * five-step BLE choreography as the desktop app:
 *
 *   1. PIN_xxxxx           → authenticate the privileged commands.
 *   2. WIFI_SCAN           → enumerate SSIDs.
 *   3. user picks SSID + types PSK
 *   4. WIFI_CONNECT ssid:psk
 *   5. drop the BLE link, bounce to scan; the robot reappears in
 *      the Distant section once it lands on the network.
 *
 * Routing on entry
 * ────────────────
 * We cross-check two daemon endpoints to decide whether the user
 * landed here on a robot that's already connected:
 *
 *   - `NETWORK_STATUS` (GATT, plain text): coarse-grained, returns
 *     `CONNECTED` for *any* non-loopback IP. A robot wired on
 *     Ethernet alone would still report `CONNECTED` and route a
 *     naive client straight to "Already on Wi-Fi".
 *   - `WIFI_STATUS` (BLE command, JSON, no auth required): granular
 *     mode (`wlan` / `hotspot` / `disconnected` / `busy`) and the
 *     active SSID when in `wlan`.
 *
 * The combination tells us exactly whether to land on `already-online`
 * (Wi-Fi mode is `wlan`) vs the PIN flow (any other state, including
 * "wired-only").
 *
 * Sub-views live next to this file under `./wifi-setup/`. This module
 * stays focused on the state machine + handlers.
 */
import { useEffect, useState } from 'react';
import { IconButton, Stack, Typography } from '@mui/material';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';

import {
  extractRobotHardwareId,
  fetchRobotsFromCentral,
} from '@/auth/fetchRobotsFromCentral';
import { PIN_INPUT_LENGTH } from '@/ui/design/PinInput';
import { useBleSession } from '@/ble/useBleSession';
import { useWifiSetup } from '@/wifi/useWifiSetup';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';

import { AlreadyOnlineView } from './wifi-setup/AlreadyOnlineView';
import {
  ConnectingView,
  ForgettingView,
  VerifyingView,
} from './wifi-setup/InFlightView';
import { FailedView } from './wifi-setup/FailedView';
import { PinView } from './wifi-setup/PinView';
import { PreparingView } from './wifi-setup/PreparingView';
import { PskView } from './wifi-setup/PskView';
import { ScanView } from './wifi-setup/ScanView';

interface WifiSetupScreenProps {
  /**
   * Bounce back to the discovery screen. Called for every terminal
   * exit from this screen: user-cancelled, verification complete,
   * forget complete, or error dismiss. App.tsx routes this back to
   * the scan list.
   */
  onBack: () => void;
  /**
   * HF token used to poll `/api/robot-status` during the `verifying`
   * phase. Verification waits for the freshly-joined robot to send a
   * heartbeat to central that **post-dates** the moment we triggered
   * WIFI_CONNECT - that is the only signal that proves the robot is
   * not just locally on its target SSID, but also actually reachable
   * through HF central (the connection path the mobile app uses).
   * Without a token we cannot verify and fall back to a fast bounce
   * after the BLE round-trip ACK.
   */
  token: string | null;
}

/** Cadence for `/api/robot-status` polls during the `verifying` phase. */
const VERIFYING_POLL_INTERVAL_MS = 2_000;
/**
 * Total wall-clock for the verifying phase before declaring failure.
 * Sized for the worst-case warm reconnect: nmcli connect (5-15 s) +
 * DHCP (~3 s) + DNS to central (~1 s) + TLS handshake (~2 s) + heartbeat
 * negotiation (~5 s) + central refresh (~2 s) plus margin for slow
 * mobile networks. Real-world successes typically land in 10-30 s; we
 * keep the watchdog generous so we never give up on a working
 * connection that's simply slow.
 */
const VERIFYING_TIMEOUT_MS = 120_000;
/** Slack added to the freshness check to absorb clock skew between
 * the mobile device and the HF central server. */
const VERIFYING_FRESHNESS_BUFFER_S = 2;

type Phase =
  | 'preparing'        // BLE link + routing reads in flight (default landing)
  | 'pin'              // user enters the 5-digit PIN to start a setup flow
  | 'pin-forget'       // user enters the PIN to authorise a forget flow
  | 'already-online'   // mode=wlan, only entry to the forget flow
  | 'scan'             // pick an SSID
  | 'psk'              // enter password for selected SSID
  | 'connecting'       // WIFI_CONNECT in flight (BLE round-trip, ~1-2 s)
  | 'verifying'        // BLE done, polling central for the robot to reappear
  | 'forgetting'       // PIN ok, WIFI_FORGET in flight (BLE disconnects on return)
  | 'failed';          // any terminal error
//
// On mount we always start in `preparing` and only commit to a
// destination phase (`pin` or `already-online`) once both the BLE
// connect AND the parallel NETWORK_STATUS + WIFI_STATUS reads have
// landed. Without this gate the user briefly sees the PIN view
// before being yanked over to "Already on Wi-Fi" (or vice versa),
// which reads as a flicker.
//
// The connect path goes through TWO in-flight phases:
//
//   1. `connecting` — BLE WIFI_CONNECT round-trip. The daemon ACKs
//      almost instantly; the actual nmcli connect runs async on its
//      side. We keep the BLE link alive after the ACK so we can
//      observe progress on it (fast-fail on wrong PSK).
//   2. `verifying` — three concurrent watchers:
//        a. BLE fast-fail: ``setup.status`` shows hotspot fallback
//           with an error string  -> `failed` immediately.
//        b. Central freshness poll: query
//           `/api/robot-status` every 2 s and accept the FIRST
//           entry whose `meta.hardware_id` matches AND whose
//           `last_seen_age_seconds` is younger than the time
//           since we triggered WIFI_CONNECT. The freshness window
//           is what distinguishes a post-reconnect heartbeat from
//           the pre-forget stale registration that the central TTL
//           sweeper takes up to 30 s to evict.
//        c. 60 s watchdog as the last-resort fail.
//      Local-only Wi-Fi commit (BLE WIFI_STATUS = wlan) is NOT
//      treated as success: a daemon can be on Wi-Fi yet not
//      reachable through HF central, and central is the mobile
//      app's actual connection path.
//
// The forget flow is single-phase (`forgetting`): we just send
// WIFI_FORGET and bounce, since there is nothing to verify - the
// robot is supposed to drop off everywhere, including central.

export default function WifiSetupScreen({ onBack, token }: WifiSetupScreenProps) {
  const {
    selectedDevice,
    connectedAddress,
    networkStatus,
    connectToDevice,
    disconnectDevice,
    readNetworkStatus,
    status: bleStatus,
  } = useBleSession();
  const setup = useWifiSetup();

  const [phase, setPhase] = useState<Phase>('preparing');
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [selectedSsid, setSelectedSsid] = useState<string | null>(null);
  const [psk, setPsk] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /** SSID the robot reports it's currently connected to (only set when
   * we landed on `already-online`). `null` means we haven't observed
   * one yet - the forget flow falls back to a fresh `WIFI_STATUS` read
   * before sending `WIFI_FORGET <ssid>`. */
  const [currentSsid, setCurrentSsid] = useState<string | null>(null);
  /**
   * Wall-clock (Unix ms) of the moment we triggered WIFI_CONNECT.
   * Drives the freshness check on central's `last_seen_age_seconds`
   * during verification: a heartbeat older than `(now - this) / 1000`
   * is necessarily a stale registration that hasn't been swept yet,
   * not the post-reconnect heartbeat we are waiting for.
   */
  const [verificationStartedAt, setVerificationStartedAt] = useState<
    number | null
  >(null);

  // ─── BLE connect + routing on mount ───────────────────────────────
  //
  // The screen stays in `preparing` for the entire duration of this
  // effect. We only commit to `pin` or `already-online` once we have
  // a definitive answer from the daemon, so the user never sees the
  // PIN boxes flash before being yanked over to "Already on Wi-Fi"
  // (or the reverse). Failure paths route to `failed` directly.
  useEffect(() => {
    if (!selectedDevice) {
      setErrorMsg('No robot selected.');
      setPhase('failed');
      return;
    }
    let cancelled = false;
    void (async () => {
      // Reuse the existing BLE session when the user came back from
      // the scan list without dropping it.
      if (
        connectedAddress !== selectedDevice.address ||
        connectedAddress === null
      ) {
        const ok = await connectToDevice(selectedDevice);
        if (cancelled) return;
        if (!ok) {
          setErrorMsg('Could not connect over Bluetooth.');
          setPhase('failed');
          return;
        }
      }

      // Fire NETWORK_STATUS (GATT, plain text) and WIFI_STATUS
      // (BLE command, JSON) in parallel. WIFI_STATUS is the
      // granular signal we use for routing; NETWORK_STATUS is
      // here mostly for the IPv4 we surface in `already-online`.
      //
      // `Promise.allSettled` so a transient failure on one read
      // doesn't bubble up: the daemon occasionally returns an
      // empty payload right after the BLE characteristic is
      // discovered. Falling through with `ws=null` means the
      // routing defaults to `pin`, which is the safe option.
      const [nsResult, wsResult] = await Promise.allSettled([
        readNetworkStatus(),
        setup.getStatus(),
      ]);
      if (cancelled) return;

      const ns = nsResult.status === 'fulfilled' ? nsResult.value : null;
      const ws = wsResult.status === 'fulfilled' ? wsResult.value : null;

      // Routing rules:
      //
      //   1. WIFI_STATUS.mode === 'wlan'  → already on Wi-Fi.
      //      The daemon's WLAN mode means an nmcli connection is
      //      active on wlan0 with a non-hotspot SSID, which is the
      //      only state that justifies the "already online" page.
      //   2. Anything else → PIN flow. NETWORK_STATUS=connected
      //      with WIFI_STATUS missing OR not-wlan = probably
      //      eth0-only, which is exactly the case we used to
      //      false-positive on with the GATT-only routing.
      if (ws?.mode === 'wlan') {
        setCurrentSsid(ws.connected ?? null);
        setPhase('already-online');
        return;
      }
      if (ws === null && ns === null) {
        console.warn(
          '[wifi-setup] both WIFI_STATUS and NETWORK_STATUS reads failed - falling through to PIN',
        );
      }
      setPhase('pin');
    })();
    return () => {
      cancelled = true;
    };
    // selectedDevice.address is the stable identity; the function refs
    // are stable thanks to zustand selectors and useCallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice?.address]);

  // ─── Verification: BLE fast-fail watcher ───────────────────────────
  //
  // ``setup.status`` (BLE WIFI_STATUS, fast-polled at 1.5 s by
  // ``useWifiSetup`` after a connect) is the cheap signal we use to
  // bail out early on a definitive failure - typically a wrong PSK
  // that bounces the daemon back to hotspot mode with a clear-text
  // ``error`` string. We do NOT use ``mode === 'wlan'`` as a success
  // signal: a daemon can be locally on Wi-Fi yet still unreachable
  // from the mobile app (no internet, captive portal, central hiccup,
  // ...). The authoritative success signal lives on central, see the
  // next effect.
  useEffect(() => {
    if (phase !== 'verifying') return;
    const m = setup.status?.mode;
    const err = setup.status?.error;
    if ((m === 'hotspot' || m === 'disconnected') && err) {
      setErrorMsg(err);
      setPhase('failed');
    }
  }, [phase, setup.status?.mode, setup.status?.error]);

  // ─── Verification: central freshness poll ─────────────────────────
  //
  // The user's ground truth for "the robot is usable from the mobile
  // app" is **a fresh entry on central**, since central is the
  // mobile app's connection path (WebRTC signaling). Local Wi-Fi
  // commit is a necessary but not sufficient condition.
  //
  // Stale-registration trap. Central can show the robot's previous
  // registration (the one from before WIFI_FORGET) for up to
  // ``LEASE_SECONDS`` (~30 s) until the TTL sweeper evicts it. A
  // naive "is the hwid in the listing?" check would false-positive
  // on that ghost. We solve it with a timestamp comparison:
  //
  //     last_seen_age_seconds < (now - verificationStartedAt) / 1000 + buffer
  //
  // i.e. the heartbeat must have been received AFTER we triggered
  // WIFI_CONNECT. A stale entry's age increases monotonically until
  // eviction, so it can never satisfy this inequality.
  useEffect(() => {
    if (phase !== 'verifying') return;
    if (verificationStartedAt === null) return;
    const targetHwid = selectedDevice?.hardwareId ?? null;
    if (!targetHwid || !token) {
      // Without an identity to match OR a token to query central,
      // we cannot verify. Bounce immediately - the user lands on
      // ScanScreen and visually confirms when the robot shows up
      // in the Distant section. No regression vs the legacy
      // fire-and-forget UX.
      onBack();
      return;
    }

    let cancelled = false;
    let pollHandle: number | null = null;

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const result = await fetchRobotsFromCentral(token);
        if (cancelled) return;
        if (result.ok) {
          const found = result.robots.find(
            (r) => extractRobotHardwareId(r) === targetHwid,
          );
          if (found) {
            const age = found.last_seen_age_seconds;
            const tSinceStartS =
              (Date.now() - verificationStartedAt) / 1000 +
              VERIFYING_FRESHNESS_BUFFER_S;
            // Reject ghosts: undefined age (very old central) and any
            // age older than our submit window can only be the
            // pre-forget registration.
            if (age !== undefined && age <= tSinceStartS) {
              cancelled = true;
              if (pollHandle) window.clearTimeout(pollHandle);
              void (async () => {
                try {
                  await disconnectDevice();
                } catch {
                  /* best-effort */
                }
                onBack();
              })();
              return;
            }
          }
        }
      } catch {
        /* network hiccup, retry on the next tick */
      }
      pollHandle = window.setTimeout(
        () => void poll(),
        VERIFYING_POLL_INTERVAL_MS,
      );
    };

    void poll();
    return () => {
      cancelled = true;
      if (pollHandle) window.clearTimeout(pollHandle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, verificationStartedAt, selectedDevice?.hardwareId, token]);

  // ─── Verifying watchdog ──────────────────────────────────────────
  //
  // 2 min upper bound. Real-world reconnects land in 10-30 s; the
  // watchdog only fires on a genuinely stuck stack (nmcli, captive
  // portal, central down, slow mobile network, ...).
  useEffect(() => {
    if (phase !== 'verifying') return;
    const id = window.setTimeout(() => {
      setErrorMsg(
        setup.status?.error ??
          "We didn't see your Reachy come online with HF central " +
            'within 2 minutes. It may still be joining; check the ' +
            '"Distant" section of the home screen in a minute.',
      );
      setPhase('failed');
    }, VERIFYING_TIMEOUT_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ─── Handlers ─────────────────────────────────────────────────────
  //
  // The PIN view (``PinView``) is shared between two flows: the
  // first-time setup (PIN → scan → PSK → connect) and the
  // re-provisioning forget flow (PIN → WIFI_FORGET → BLE drop). Each
  // flow has its own submit handler; the view itself is identical
  // visually so the user never sees a "different PIN screen" for the
  // two cases.
  const handleSubmitPin = async (pinValue: string): Promise<void> => {
    setPinError(null);
    if (pinValue.length !== PIN_INPUT_LENGTH) {
      // Shouldn't happen because PinInput auto-submits at exactly
      // PIN_INPUT_LENGTH, but keep the guard for parent-driven calls.
      setPinError(`PIN must be ${PIN_INPUT_LENGTH} digits.`);
      return;
    }
    const ok = await setup.authenticate(pinValue);
    if (!ok) {
      // Wrong-PIN: clear so the user starts over with the next
      // attempt. Auth errors are nearly always typos; we surface the
      // daemon's message verbatim only when it's NOT the standard
      // "incorrect PIN" - that one we phrase ourselves for clarity.
      setPin('');
      setPinError(setup.error ?? 'Wrong PIN, try again.');
      return;
    }
    setPin('');
    setPhase('scan');
    void setup.scan();
  };

  const handleSubmitPinForget = async (pinValue: string): Promise<void> => {
    setPinError(null);
    if (pinValue.length !== PIN_INPUT_LENGTH) {
      setPinError(`PIN must be ${PIN_INPUT_LENGTH} digits.`);
      return;
    }
    const authOk = await setup.authenticate(pinValue);
    if (!authOk) {
      setPin('');
      setPinError(setup.error ?? 'Wrong PIN, try again.');
      return;
    }
    setPin('');
    setPhase('forgetting');
    // Re-read WIFI_STATUS at this point: the cached `currentSsid` we
    // captured during routing might be a few seconds old, and the
    // daemon may have churned (e.g. signal drop + auto-reconnect to a
    // different known SSID). Going through `getStatus()` once more
    // gives us the authoritative SSID right before we tell the daemon
    // to drop it.
    let ssid = currentSsid;
    if (!ssid) {
      try {
        const fresh = await setup.getStatus();
        ssid = fresh?.connected ?? null;
      } catch {
        /* fall through to the null-ssid branch below */
      }
    }
    if (!ssid) {
      setErrorMsg('The robot does not appear to be on a Wi-Fi network.');
      setPhase('failed');
      return;
    }
    const forgotten = await setup.forget(ssid, { disconnectAfter: true });
    if (!forgotten) {
      setErrorMsg(setup.error ?? 'Could not forget the Wi-Fi network.');
      setPhase('failed');
      return;
    }
    // ``setup.forget(..., disconnectAfter: true)`` already closed the
    // BLE link. The robot is bouncing back to its hotspot now; bounce
    // the user back to the discovery screen so they can re-pair when
    // it shows up.
    onBack();
  };

  const handlePickSsid = (ssid: string): void => {
    setSelectedSsid(ssid);
    setPsk('');
    setPhase('psk');
  };

  const handleSubmitPsk = async (): Promise<void> => {
    if (!selectedSsid) return;
    setErrorMsg(null);
    // Trim invisible whitespace that almost always comes from a
    // copy-paste off a sticker. WPA2 passwords can technically
    // contain leading/trailing spaces, but in practice that's so
    // rare and the typo case so common that the trade-off favours
    // trim. Power users can disable it from a future settings panel.
    const trimmedPsk = psk.trim();
    // Snapshot the start-of-verify timestamp BEFORE we send the
    // command, so any heartbeat with `last_seen_age` younger than
    // (now - this) is unambiguously post-WIFI_CONNECT.
    setVerificationStartedAt(Date.now());
    setPhase('connecting');
    const ok = await setup.connect(selectedSsid, trimmedPsk);
    if (!ok) {
      setErrorMsg(setup.error ?? 'Could not start the Wi-Fi connect.');
      setPhase('failed');
      return;
    }
    // BLE WIFI_CONNECT command was ACK'd. Keep the BLE link alive
    // (the BLE watcher below detects fast-fail conditions like a
    // wrong PSK) and switch to verifying. The central watcher polls
    // until a freshly-stamped heartbeat lands.
    setPhase('verifying');
  };

  const handleRetry = (): void => {
    setErrorMsg(null);
    setPinError(null);
    setSelectedSsid(null);
    setPsk('');
    setPhase('pin');
  };

  // ─── Render ───────────────────────────────────────────────────────
  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        px: 3,
        pt: LAYOUT.safeAreaTop,
        pb: 4,
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ mb: 2, minHeight: 40 }}
      >
        {/* Disable Back during in-flight BLE round-trips: WIFI_CONNECT
            (connecting) and WIFI_FORGET (forgetting) both keep running
            on the daemon side regardless of what the UI does, so a
            tap here would feel like a cancel without actually
            cancelling anything. Re-enabled during `verifying` so a
            user who's stuck waiting (e.g. their phone is parked on a
            now-defunct hotspot) can opt out of the watchdog. */}
        <IconButton
          aria-label="Back"
          onClick={onBack}
          edge="start"
          disabled={phase === 'connecting' || phase === 'forgetting'}
        >
          <ArrowBackIosNewIcon />
        </IconButton>
        <Typography
          sx={{
            flex: 1,
            fontSize: TYPO.lg,
            fontWeight: FONT_WEIGHT.semibold,
            textAlign: 'center',
            mr: 5,
          }}
          noWrap
        >
          Wi-Fi setup
        </Typography>
      </Stack>

      <Stack
        flex={1}
        alignItems="center"
        justifyContent="center"
        spacing={3}
        sx={{
          width: '100%',
          maxWidth: LAYOUT.contentMaxWidth,
          mx: 'auto',
          overflowY: 'auto',
          minHeight: 0,
        }}
      >
        {phase === 'preparing' && <PreparingView bleStatus={bleStatus} />}

        {phase === 'already-online' && (
          <AlreadyOnlineView
            ssid={currentSsid}
            ip={networkStatus?.ip ?? null}
            onForget={() => {
              setPin('');
              setPinError(null);
              setPhase('pin-forget');
            }}
          />
        )}

        {phase === 'pin' && (
          <PinView
            pin={pin}
            onPinChange={setPin}
            onComplete={(value) => void handleSubmitPin(value)}
            error={pinError}
            isBusy={setup.isBusy}
          />
        )}

        {phase === 'pin-forget' && (
          <PinView
            pin={pin}
            onPinChange={setPin}
            onComplete={(value) => void handleSubmitPinForget(value)}
            error={pinError}
            isBusy={setup.isBusy}
            intent="forget"
            currentSsid={currentSsid}
          />
        )}

        {phase === 'scan' && (
          <ScanView
            isBusy={setup.isBusy}
            ssids={setup.scanResults}
            error={setup.error}
            onPick={handlePickSsid}
            onRefresh={() => void setup.scan()}
          />
        )}

        {phase === 'psk' && selectedSsid && (
          <PskView
            ssid={selectedSsid}
            psk={psk}
            onPskChange={setPsk}
            isBusy={setup.isBusy}
            onSubmit={() => void handleSubmitPsk()}
            onCancel={() => setPhase('scan')}
          />
        )}

        {phase === 'connecting' && <ConnectingView ssid={selectedSsid} />}

        {phase === 'verifying' && <VerifyingView ssid={selectedSsid} />}

        {phase === 'forgetting' && <ForgettingView ssid={currentSsid} />}

        {phase === 'failed' && (
          <FailedView
            rawError={errorMsg}
            onRetry={handleRetry}
            onBack={onBack}
            onProbe={() => setup.probe()}
            bleConnected={!!connectedAddress}
          />
        )}
      </Stack>
    </Stack>
  );
}
