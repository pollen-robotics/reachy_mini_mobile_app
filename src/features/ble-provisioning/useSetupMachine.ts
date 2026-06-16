/**
 * First-time setup state machine.
 *
 * Drives the BLE Wi-Fi provisioning wizard end to end:
 *
 *   permission → scanning → connecting → pin → authenticating
 *     → wifi-scanning → wifi-pick → wifi-password
 *     → wifi-connecting → central-waiting → done
 *
 * Any step can fail into `error` with a `recoverPhase` so "Try again" bounces
 * the user to the right step instead of restarting the whole flow.
 *
 * The transport + crypto live in `features/ble/bleWifi.ts` (battle-tested on
 * real hardware); the typed protocol in `./protocol.ts`. This hook owns the
 * orchestration, the React state, and the central-listing handoff.
 *
 * Concurrency: every long async chain captures a `runId`. `cancel()`, `retry()`
 * and a fresh device selection bump the id, so a stale loop (e.g. a Wi-Fi poll
 * still running after the user backed out) sees `runId !== current` and exits
 * without touching state. A `mountedRef` guards against post-unmount setState.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type BleDevice,
  type ScanController,
  connect as bleConnect,
  disconnect as bleDisconnect,
  reachyBySignal,
  startContinuousScan,
  watchConnection,
} from '@/features/ble/bleWifi';
import {
  type CentralRobotEntry,
  extractRobotHardwareId,
  fetchRobotsFromCentral,
} from '@/features/auth/fetchRobotsFromCentral';
import {
  authenticate,
  connectSealed,
  keyExchange,
  readIdentity,
  scanWifi,
  toSetupError,
  wifiStatus,
} from './protocol';
import { openExternalUrl } from '@/shared/tauri/openUrl';
import type { RobotIdentity, SetupError, SetupPhase, SetupResult } from './types';

// Wi-Fi join polling: nmcli connect + DHCP can take a while; the daemon
// reverts to its hotspot on failure (and sets `error`).
const WIFI_POLL_INTERVAL_MS = 2_500;
const WIFI_POLL_TIMEOUT_MS = 45_000;
// Central registration after a successful Wi-Fi join: the robot has to reach
// the HF Space and register as a producer, which lags the local join.
const CENTRAL_POLL_INTERVAL_MS = 4_000;
const CENTRAL_POLL_TIMEOUT_MS = 75_000;
// Robot-side OAuth entry point: opening this in the system browser makes the
// robot's daemon redirect to Hugging Face, handle the callback, store its own
// token, and start the central relay. Reached by mDNS hostname (matches the
// daemon's registered OAuth redirect URI) — the phone must be on the robot's
// Wi-Fi for this to resolve and for HF to redirect back.
const ROBOT_OAUTH_BEGIN_URL = 'http://reachy-mini.local:8000/api/hf-auth/oauth/begin';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface UseSetupMachineOptions {
  /** HF token, used to poll central for the freshly-provisioned robot. */
  token: string;
}

export interface SetupMachine {
  phase: SetupPhase;
  error: SetupError | null;
  scanning: boolean;
  devices: BleDevice[];
  identity: RobotIdentity | null;
  networks: string[];
  selectedSsid: string | null;
  result: SetupResult | null;

  // actions
  startScanning: () => void;
  rescan: () => void;
  selectDevice: (device: BleDevice) => void;
  submitPin: (pin: string) => void;
  rescanWifi: () => void;
  selectNetwork: (ssid: string) => void;
  submitPassword: (password: string) => void;
  linkAccount: () => void;
  retry: () => void;
  reset: () => void;
}

export function useSetupMachine({ token }: UseSetupMachineOptions): SetupMachine {
  const [phase, setPhase] = useState<SetupPhase>('permission');
  const [error, setError] = useState<SetupError | null>(null);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [identity, setIdentity] = useState<RobotIdentity | null>(null);
  const [networks, setNetworks] = useState<string[]>([]);
  const [selectedSsid, setSelectedSsid] = useState<string | null>(null);
  const [result, setResult] = useState<SetupResult | null>(null);

  // Values threaded through async chains (avoid stale-closure reads).
  const pinRef = useRef<string>('');
  const keyexRef = useRef<string>('');
  const identityRef = useRef<RobotIdentity | null>(null);
  const mountedRef = useRef(true);
  const runIdRef = useRef(0);
  // The live continuous-scan loop (null when not scanning). Stopped before any
  // connect (the radio can't scan + connect at once) and on unmount.
  const scanCtrlRef = useRef<ScanController | null>(null);

  const stopScanLoop = useCallback(async () => {
    const ctrl = scanCtrlRef.current;
    scanCtrlRef.current = null;
    if (ctrl) await ctrl.stop();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Best-effort: stop scanning + drop the BLE link when the wizard unmounts.
      void scanCtrlRef.current?.stop();
      scanCtrlRef.current = null;
      void bleDisconnect();
    };
  }, []);

  // Drive the BLE disconnect signal: if the link drops mid-flow (not on a
  // terminal phase), surface it as a recoverable error.
  const phaseRef = useRef<SetupPhase>(phase);
  phaseRef.current = phase;
  useEffect(() => {
    void watchConnection((connected) => {
      if (connected) return;
      const p = phaseRef.current;
      const midFlow =
        p !== 'permission' && p !== 'scanning' && p !== 'done' && p !== 'error';
      if (midFlow && mountedRef.current) {
        runIdRef.current += 1; // abort any in-flight chain
        setError({
          code: 'ble-dropped',
          message: 'The Bluetooth connection dropped. Move closer and try again.',
          recoverPhase: 'scanning',
        });
        setPhase('error');
      }
    });
  }, []);

  const fail = useCallback((reply: string, fallback: SetupPhase) => {
    if (!mountedRef.current) return;
    setError(toSetupError(reply, fallback));
    setPhase('error');
  }, []);

  // ── PAIR ──────────────────────────────────────────────────────────────────

  // Continuous scan: keeps the list live the whole time the scan view is up
  // (new robots appear, vanished ones drop out) instead of a single frozen
  // sweep. Restarted on refocus and explicit rescan; stopped before connect.
  const startScanning = useCallback(() => {
    const runId = (runIdRef.current += 1);
    setError(null);
    setDevices([]);
    setScanning(true);
    setPhase('scanning');
    void stopScanLoop();
    scanCtrlRef.current = startContinuousScan({
      onUpdate: (live) => {
        if (runId === runIdRef.current && mountedRef.current) {
          // Reachy Minis only, strongest signal first.
          setDevices(reachyBySignal(live));
        }
      },
      onError: (e) => {
        if (runId !== runIdRef.current || !mountedRef.current) return;
        const msg = e.message ?? String(e);
        const permission = /permission/i.test(msg);
        setScanning(false);
        setError({
          code: permission ? 'permission-denied' : 'unknown',
          message: permission
            ? 'Bluetooth permission is needed to find your Reachy. Approve it, then scan again.'
            : msg,
          recoverPhase: 'scanning',
        });
        setPhase('error');
      },
    });
  }, [stopScanLoop]);

  const rescan = useCallback(() => startScanning(), [startScanning]);

  // Re-scan when the app comes back to the foreground while the scan view is
  // showing: mobile OSes kill an in-flight BLE scan when the app backgrounds,
  // so without this the list would silently stop refreshing on return.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && phaseRef.current === 'scanning') {
        startScanning();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [startScanning]);

  const selectDevice = useCallback(
    (device: BleDevice) => {
      const runId = (runIdRef.current += 1);
      setError(null);
      setScanning(false);
      setPhase('connecting');
      void (async () => {
        try {
          // The radio can't scan and connect simultaneously — stop the loop first.
          await stopScanLoop();
          await bleConnect(device.address);
          if (runId !== runIdRef.current || !mountedRef.current) return;
          const id = await readIdentity();
          if (runId !== runIdRef.current || !mountedRef.current) return;
          identityRef.current = id;
          setIdentity(id);
          // Name guess for display: prefer the advertised name, else generic.
          setPhase('pin');
        } catch {
          if (runId !== runIdRef.current || !mountedRef.current) return;
          setError({
            code: 'connect-failed',
            message: 'Could not connect to this robot. Make sure it is powered on and close by.',
            recoverPhase: 'scanning',
          });
          setPhase('error');
        }
      })();
    },
    [stopScanLoop],
  );

  const submitPin = useCallback(
    (pin: string) => {
      const runId = (runIdRef.current += 1);
      pinRef.current = pin;
      setError(null);
      setPhase('authenticating');
      void (async () => {
        try {
          const ok = await authenticate(pin);
          if (runId !== runIdRef.current || !mountedRef.current) return;
          if (!ok) {
            setError({ code: 'wrong-pin', message: 'Incorrect setup code. Check under the robot.', recoverPhase: 'pin' });
            setPhase('error');
            return;
          }
          const keyex = await keyExchange();
          if (runId !== runIdRef.current || !mountedRef.current) return;
          keyexRef.current = keyex;
          // chain straight into the Wi-Fi scan
          setPhase('wifi-scanning');
          const ssids = await scanWifi();
          if (runId !== runIdRef.current || !mountedRef.current) return;
          setNetworks(ssids);
          setPhase('wifi-pick');
        } catch (e) {
          if (runId !== runIdRef.current || !mountedRef.current) return;
          fail((e as Error).message ?? String(e), 'pin');
        }
      })();
    },
    [fail],
  );

  // ── NETWORK ────────────────────────────────────────────────────────────────

  const rescanWifi = useCallback(() => {
    const runId = (runIdRef.current += 1);
    setError(null);
    setPhase('wifi-scanning');
    void (async () => {
      try {
        const ssids = await scanWifi();
        if (runId !== runIdRef.current || !mountedRef.current) return;
        setNetworks(ssids);
        setPhase('wifi-pick');
      } catch (e) {
        if (runId !== runIdRef.current || !mountedRef.current) return;
        fail((e as Error).message ?? String(e), 'wifi-scanning');
      }
    })();
  }, [fail]);

  const selectNetwork = useCallback((ssid: string) => {
    setSelectedSsid(ssid);
    setPhase('wifi-password');
  }, []);

  const submitPassword = useCallback(
    (password: string) => {
      const ssid = selectedSsid;
      if (!ssid) return;
      const runId = (runIdRef.current += 1);
      setError(null);
      setPhase('wifi-connecting');
      void (async () => {
        try {
          await connectSealed(ssid, password, pinRef.current, keyexRef.current);
          if (runId !== runIdRef.current || !mountedRef.current) return;

          // Poll WIFI_STATUS until the robot reports it joined `ssid`, or the
          // daemon surfaces an error (wrong password → revert to hotspot).
          const deadline = Date.now() + WIFI_POLL_TIMEOUT_MS;
          for (;;) {
            await sleep(WIFI_POLL_INTERVAL_MS);
            if (runId !== runIdRef.current || !mountedRef.current) return;
            const status = await wifiStatus();
            if (runId !== runIdRef.current || !mountedRef.current) return;
            if (status.connected && status.connected === ssid) break; // joined!
            if (status.error) {
              setError({
                code: 'wrong-password',
                message: 'Could not join the network. The password may be wrong.',
                recoverPhase: 'wifi-password',
              });
              setPhase('error');
              return;
            }
            if (Date.now() > deadline) {
              setError({
                code: 'timeout',
                message: "The robot didn't join the network in time. Try again.",
                recoverPhase: 'wifi-password',
              });
              setPhase('error');
              return;
            }
          }

          // Joined Wi-Fi. Stop here and let the user link the robot to their
          // Hugging Face account via robot-side OAuth (see `linkAccount`): a
          // token-less robot boots with the central relay disabled and never
          // appears in the list. The user drives the next step with a tap.
          setPhase('linking-account');
        } catch (e) {
          if (runId !== runIdRef.current || !mountedRef.current) return;
          fail((e as Error).message ?? String(e), 'wifi-password');
        }
      })();
    },
    [selectedSsid, fail],
  );

  // ── ACCOUNT LINK (robot-side OAuth) ──────────────────────────────────────────

  // Open the robot's OAuth entry point in the system browser. The robot
  // (reachy-mini.local) redirects to Hugging Face, handles the callback, stores
  // its OWN durable token, and starts the central relay. We then just wait for
  // it to appear on central — the same poll the wizard already uses.
  const linkAccount = useCallback(() => {
    const runId = (runIdRef.current += 1);
    setError(null);
    void (async () => {
      try {
        await openExternalUrl(ROBOT_OAUTH_BEGIN_URL);
        if (runId !== runIdRef.current || !mountedRef.current) return;
        setPhase('central-waiting');
        const hwid = identityRef.current?.hardwareId ?? null;
        const matched = await waitForCentral(token, hwid, runId, runIdRef, mountedRef);
        if (runId !== runIdRef.current || !mountedRef.current) return;
        setResult({ hardwareId: hwid, robot: matched });
        setPhase('done');
      } catch (e) {
        if (runId !== runIdRef.current || !mountedRef.current) return;
        fail((e as Error).message ?? String(e), 'linking-account');
      }
    })();
  }, [token, fail]);

  // ── recovery / lifecycle ────────────────────────────────────────────────────

  const retry = useCallback(() => {
    const target = error?.recoverPhase ?? 'scanning';
    setError(null);
    if (target === 'scanning') {
      startScanning();
    } else {
      // Re-enter the relevant step; the user re-performs the action (pin,
      // password, …). Bumping runId invalidates any stale chain.
      runIdRef.current += 1;
      setPhase(target);
    }
  }, [error, startScanning]);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    void stopScanLoop();
    void bleDisconnect();
    pinRef.current = '';
    keyexRef.current = '';
    identityRef.current = null;
    setError(null);
    setScanning(false);
    setDevices([]);
    setIdentity(null);
    setNetworks([]);
    setSelectedSsid(null);
    setResult(null);
    setPhase('permission');
  }, [stopScanLoop]);

  return {
    phase,
    error,
    scanning,
    devices,
    identity,
    networks,
    selectedSsid,
    result,
    startScanning,
    rescan,
    selectDevice,
    submitPin,
    rescanWifi,
    selectNetwork,
    submitPassword,
    linkAccount,
    retry,
    reset,
  };
}

/**
 * Poll HF central until a robot whose `meta.hardware_id` matches the BLE
 * `hardwareId` shows up, or we give up. Returns the matching entry, or `null`
 * (Wi-Fi joined but not yet registered - the user is sent back to the list to
 * wait it out). When we have no hwid to match on, we resolve `null` quickly.
 */
async function waitForCentral(
  token: string,
  hardwareId: string | null,
  runId: number,
  runIdRef: { current: number },
  mountedRef: { current: boolean },
): Promise<CentralRobotEntry | null> {
  if (!hardwareId) {
    // Nothing to match on - give central a short grace period, then defer to
    // the list. (Avoids hanging on the spinner for a full timeout.)
    await sleep(CENTRAL_POLL_INTERVAL_MS);
    return null;
  }
  const deadline = Date.now() + CENTRAL_POLL_TIMEOUT_MS;
  for (;;) {
    const res = await fetchRobotsFromCentral(token);
    if (runId !== runIdRef.current || !mountedRef.current) return null;
    if (res.ok) {
      const match = res.robots.find((r) => extractRobotHardwareId(r) === hardwareId);
      if (match) return match;
    }
    if (Date.now() > deadline) return null;
    await sleep(CENTRAL_POLL_INTERVAL_MS);
    if (runId !== runIdRef.current || !mountedRef.current) return null;
  }
}
