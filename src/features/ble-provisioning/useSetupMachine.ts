/**
 * First-time setup state machine.
 *
 * Drives the BLE Wi-Fi provisioning wizard end to end:
 *
 *   scanning → connecting → pin → authenticating → wifi-scanning → wifi-pick
 *     → wifi-connecting → linking-account → central-waiting → naming → done
 *
 * Account linking (robot-side HF OAuth) runs BEFORE naming so the robot is
 * fully online first; naming is the last human step, and the "settle to sleep"
 * end cue plays right after it, on the way to `done`.
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
  IDENTIFY_MOVE,
  MIN_WIFI_SETUP_VERSION,
  RobotOutdatedError,
  SLEEP_MOVE,
  WAITING_MOVE,
  authenticate,
  connectSealed,
  keyExchange,
  play,
  readIdentity,
  readNetworkInfo,
  scanWifi,
  setRobotName,
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
// After a Wi-Fi join, the daemon's NETWORK_STATUS characteristic (cdef4)
// refreshes on a ~10 s tick, so the freshly-assigned LAN IP can lag the join by
// a few seconds. Poll it briefly so we can hand OAuth a literal IP.
const IP_POLL_INTERVAL_MS = 1_500;
const IP_POLL_TIMEOUT_MS = 12_000;

// Robot-side OAuth entry point: opening this in the system browser makes the
// robot's daemon redirect to Hugging Face, handle the callback, store its own
// token, and start the central relay. We prefer the LAN IP we just read over
// BLE — mDNS (`reachy-mini.local`) is unreliable on many networks — and fall
// back to the hostname when no IP could be read. Either way the phone must be
// on the robot's Wi-Fi for HF to redirect back.
const ROBOT_OAUTH_MDNS_HOST = 'reachy-mini.local';
function robotOAuthBeginUrl(host: string): string {
  return `http://${host}:8000/api/hf-auth/oauth/begin`;
}

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
  /** LAN IP the robot got after joining Wi-Fi, discovered over BLE. `null`
   *  until known (or if it couldn't be read — OAuth then falls back to mDNS). */
  robotLanIp: string | null;

  // actions
  startScanning: () => void;
  rescan: () => void;
  selectDevice: (device: BleDevice) => void;
  submitPin: (pin: string) => void;
  rescanWifi: () => void;
  selectNetwork: (ssid: string) => void;
  submitPassword: (password: string, ssid?: string) => void;
  commitName: (name: string) => void;
  finishNaming: () => void;
  linkAccount: () => void;
  retry: () => void;
  reset: () => void;
  /** Rewind one logical step (see `goBack`). */
  goBack: () => void;
  /** Whether an in-flow previous step exists; when false the header's Back
   *  button should exit the wizard instead. */
  canGoBack: boolean;
}

export function useSetupMachine({ token }: UseSetupMachineOptions): SetupMachine {
  // The wizard opens straight on the scan step. The old intro/permission
  // screen was pure wording - the OS Bluetooth permission prompt is raised
  // by the scan attempt itself (see `startScanning`'s error handling).
  const [phase, setPhase] = useState<SetupPhase>('scanning');
  const [error, setError] = useState<SetupError | null>(null);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [identity, setIdentity] = useState<RobotIdentity | null>(null);
  const [networks, setNetworks] = useState<string[]>([]);
  const [selectedSsid, setSelectedSsid] = useState<string | null>(null);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [robotLanIp, setRobotLanIp] = useState<string | null>(null);

  // Values threaded through async chains (avoid stale-closure reads).
  const pinRef = useRef<string>('');
  const keyexRef = useRef<string>('');
  const identityRef = useRef<RobotIdentity | null>(null);
  // LAN IP read over BLE after the Wi-Fi join; drives the OAuth URL. Kept in a
  // ref too so `linkAccount` reads it without a stale closure.
  const robotIpRef = useRef<string | null>(null);
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
      const midFlow = p !== 'scanning' && p !== 'done' && p !== 'error';
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

  // The robot echoed a setup command back instead of running it → its software
  // predates the BLE Wi-Fi setup (v1.8.2). The echo (read synchronously off
  // RESPONSE) is itself the definitive signal, so there's nothing more to ask:
  // `UPDATE_CHECK` shares the same v1.8.2 floor and would just echo too.
  const failOutdated = useCallback(() => {
    setError({
      code: 'robot-outdated',
      message:
        'This Reachy’s software is too old to set up Wi-Fi over Bluetooth. ' +
        `It needs ${MIN_WIFI_SETUP_VERSION} or newer. Update it from the Reachy ` +
        'desktop app, then start setup again.',
      recoverPhase: 'scanning',
    });
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

  // Auto-start the BLE scan on mount: the wizard lands directly on the scan
  // step now (no intro screen to tap through). Intentionally NO mount-guard
  // ref: under StrictMode the effect is cleaned up + re-run, and a persisted
  // guard would skip the restart and leave the view with a dead (stopped)
  // scanner - which showed up as an empty list. `startScanning` is stable and
  // bumps the shared scan token, so a dev double-invoke just supersedes its
  // own previous loop; on unmount the scanner is torn down by the cleanup
  // effect above.
  useEffect(() => {
    startScanning();
  }, [startScanning]);

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
          // Play the identify move (motion + sound) so the user sees/hears
          // which physical Reachy they just tapped. Public BLE command (no
          // PIN). Kept SEQUENTIAL on the shared command/response channel (a
          // concurrent sendCommand would flush the notification backlog and
          // could collide with the PIN step); best-effort so a failed cue
          // never blocks setup.
          await play(IDENTIFY_MOVE);
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

  // The daemon's first `WIFI_SCAN` right after the robot leaves AP/hotspot mode
  // usually returns an EMPTY list: `scan_available_wifi()` kicks off an async
  // `nmcli rescan` then reads the cache immediately, so the fresh results land
  // only on the next call. That's why a manual "Rescan" worked. Retry a few
  // times automatically so the user never sees a spuriously empty list.
  const scanWifiResilient = useCallback(async (runId: number): Promise<string[]> => {
    const ATTEMPTS = 3;
    const RETRY_DELAY_MS = 1800;
    let found: string[] = [];
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        found = await scanWifi();
      } catch (e) {
        // A transient "busy" (a rescan already in flight) is worth retrying;
        // any other error — or busy on the last attempt — propagates.
        if (i === ATTEMPTS - 1 || !/busy/i.test((e as Error).message ?? '')) throw e;
      }
      if (runId !== runIdRef.current || !mountedRef.current) return found;
      if (found.length > 0) return found;
      if (i < ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
      if (runId !== runIdRef.current || !mountedRef.current) return found;
    }
    return found;
  }, []);

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
          const ssids = await scanWifiResilient(runId);
          if (runId !== runIdRef.current || !mountedRef.current) return;
          setNetworks(ssids);
          setPhase('wifi-pick');
        } catch (e) {
          if (runId !== runIdRef.current || !mountedRef.current) return;
          if (e instanceof RobotOutdatedError) {
            failOutdated();
            return;
          }
          fail((e as Error).message ?? String(e), 'pin');
        }
      })();
    },
    [fail, failOutdated, scanWifiResilient],
  );

  // ── NETWORK ────────────────────────────────────────────────────────────────

  const rescanWifi = useCallback(() => {
    const runId = (runIdRef.current += 1);
    setError(null);
    setPhase('wifi-scanning');
    void (async () => {
      try {
        const ssids = await scanWifiResilient(runId);
        if (runId !== runIdRef.current || !mountedRef.current) return;
        setNetworks(ssids);
        setPhase('wifi-pick');
      } catch (e) {
        if (runId !== runIdRef.current || !mountedRef.current) return;
        if (e instanceof RobotOutdatedError) {
          failOutdated();
          return;
        }
        fail((e as Error).message ?? String(e), 'wifi-scanning');
      }
    })();
  }, [fail, failOutdated, scanWifiResilient]);

  // Selecting a network no longer advances to a separate password phase:
  // the pick view expands the chosen SSID inline (accordion) and owns the
  // password entry, so both live in the single `wifi-pick` step. We still
  // record the SSID so `submitPassword` (and the wrong-password recovery)
  // has it even without an explicit argument.
  const selectNetwork = useCallback((ssid: string) => {
    setSelectedSsid(ssid);
  }, []);

  const submitPassword = useCallback(
    (password: string, ssidArg?: string) => {
      const ssid = ssidArg ?? selectedSsid;
      if (!ssid) return;
      if (ssidArg && ssidArg !== selectedSsid) setSelectedSsid(ssidArg);
      const runId = (runIdRef.current += 1);
      setError(null);
      setPhase('wifi-connecting');
      void (async () => {
        try {
          await connectSealed(ssid, password, pinRef.current, keyexRef.current);
          if (runId !== runIdRef.current || !mountedRef.current) return;

          // Cue the "waiting" idle (motion + sound) while the join runs. Fired
          // SEQUENTIALLY (awaited) BEFORE the poll loop: the BLE command/
          // response channel is shared, so a concurrent PLAY would collide with
          // the WIFI_STATUS / NETWORK_STATUS reads below. `play` is fire-and-
          // forget daemon-side and best-effort, so this returns fast.
          await play(WAITING_MOVE);
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
                recoverPhase: 'wifi-pick',
              });
              setPhase('error');
              return;
            }
            if (Date.now() > deadline) {
              setError({
                code: 'timeout',
                message: "The robot didn't join the network in time. Try again.",
                recoverPhase: 'wifi-pick',
              });
              setPhase('error');
              return;
            }
          }

          // Joined Wi-Fi. Read the LAN IP the robot just got so we can reach its
          // OAuth endpoint directly. NETWORK_STATUS refreshes on a ~10 s tick, so
          // poll briefly until it reports `connected` with an address. Entirely
          // best-effort: any failure leaves the IP null and `linkAccount` falls
          // back to mDNS.
          robotIpRef.current = null;
          setRobotLanIp(null);
          const ipDeadline = Date.now() + IP_POLL_TIMEOUT_MS;
          for (;;) {
            try {
              const net = await readNetworkInfo();
              if (runId !== runIdRef.current || !mountedRef.current) return;
              if (net.mode === 'connected' && net.ip) {
                robotIpRef.current = net.ip;
                setRobotLanIp(net.ip);
                break;
              }
            } catch {
              if (runId !== runIdRef.current || !mountedRef.current) return;
            }
            if (Date.now() > ipDeadline) break; // give up; mDNS fallback
            await sleep(IP_POLL_INTERVAL_MS);
            if (runId !== runIdRef.current || !mountedRef.current) return;
          }

          // Cue the "waiting" idle again while the account-link step is up
          // (sequential: the IP poll above has finished, nothing else holds the
          // BLE channel).
          await play(WAITING_MOVE);
          if (runId !== runIdRef.current || !mountedRef.current) return;

          // Joined Wi-Fi → hand off to robot-side HF OAuth first, so the robot
          // comes fully online before we ask the user to name it. Naming (the
          // last human step) runs after central registration.
          setPhase('linking-account');
        } catch (e) {
          if (runId !== runIdRef.current || !mountedRef.current) return;
          fail((e as Error).message ?? String(e), 'wifi-pick');
        }
      })();
    },
    [selectedSsid, fail],
  );

  // ── NAMING (robot display name over BLE) ─────────────────────────────────────

  // Fire the rename over BLE, best-effort. Deliberately does NOT change the
  // phase or bump runId: the naming view plays a short celebration and calls
  // `finishNaming` when it's done, so the BLE write runs during that beat. A
  // failed rename (old daemon, expired session, transport hiccup) is swallowed
  // - naming is non-critical and must never trap the user on setup.
  const commitName = useCallback((name: string) => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    void setRobotName(trimmed).catch(() => {
      // non-critical: ignore, the user proceeds regardless
    });
  }, []);

  // Finish setup out of the naming step (the last human step, now that OAuth
  // already ran). Plays the "settle to sleep" end cue (mini-deep-sleep) - the
  // final Bluetooth-setup animation, right after naming - so the first wake-up
  // wizard, which opens on "Tuck Me In", starts from a robot that's actually
  // asleep. BLE is still connected here (dropped until unmount), so the cue
  // lands; best-effort and fire-and-forget, so it never blocks the finish.
  const finishNaming = useCallback(() => {
    void play(SLEEP_MOVE);
    runIdRef.current += 1;
    setError(null);
    setPhase('done');
  }, []);

  // ── ACCOUNT LINK (robot-side OAuth) ──────────────────────────────────────────

  // Open the robot's OAuth entry point in the system browser (by LAN IP when
  // we have one, else mDNS). The robot redirects to Hugging Face, handles the
  // callback, stores its OWN durable token, and starts the central relay. We
  // then just wait for it to appear on central — the same poll the wizard
  // already uses. Once it's online we advance to naming (the last human step),
  // NOT straight to `done`: `finishNaming` closes the flow after the name.
  const linkAccount = useCallback(() => {
    const runId = (runIdRef.current += 1);
    setError(null);
    void (async () => {
      try {
        // Prefer the LAN IP discovered over BLE; fall back to mDNS if we never
        // read one (older daemon / quiet GATT / robot not yet `connected`).
        const host = robotIpRef.current ?? ROBOT_OAUTH_MDNS_HOST;
        await openExternalUrl(robotOAuthBeginUrl(host));
        if (runId !== runIdRef.current || !mountedRef.current) return;
        setPhase('central-waiting');
        const hwid = identityRef.current?.hardwareId ?? null;
        const matched = await waitForCentral(token, hwid, runId, runIdRef, mountedRef);
        if (runId !== runIdRef.current || !mountedRef.current) return;
        setResult({ hardwareId: hwid, robot: matched });
        setPhase('naming');
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

  // Step back one logical stage instead of bailing out of the whole wizard.
  // Any in-flight async chain is aborted first (runId bump). Returning to the
  // device list is the only destructive hop - it drops the half-open BLE link
  // and restarts the scan; the intra-session hops keep the GATT link and just
  // re-show an earlier step (the user re-performs its action to move forward).
  const goBack = useCallback(() => {
    const p = phaseRef.current;
    runIdRef.current += 1;
    setError(null);
    switch (p) {
      case 'connecting':
      case 'pin':
        void bleDisconnect();
        startScanning();
        return;
      case 'authenticating':
      case 'wifi-scanning':
      case 'wifi-pick':
        // Still authenticated over BLE - rewind to the PIN step (re-entering it
        // re-runs key-exchange + Wi-Fi scan).
        setPhase('pin');
        return;
      case 'wifi-connecting':
      case 'linking-account':
        setPhase('wifi-pick');
        return;
      case 'central-waiting':
      case 'naming':
        setPhase('linking-account');
        return;
      default:
        // scanning / done / error: no in-flow previous step.
        return;
    }
  }, [startScanning]);

  const canGoBack = phase !== 'scanning' && phase !== 'done' && phase !== 'error';

  const reset = useCallback(() => {
    runIdRef.current += 1;
    void stopScanLoop();
    void bleDisconnect();
    pinRef.current = '';
    keyexRef.current = '';
    identityRef.current = null;
    robotIpRef.current = null;
    setRobotLanIp(null);
    setError(null);
    setScanning(false);
    setDevices([]);
    setIdentity(null);
    setNetworks([]);
    setSelectedSsid(null);
    setResult(null);
    startScanning();
  }, [stopScanLoop, startScanning]);

  return {
    phase,
    error,
    scanning,
    devices,
    identity,
    networks,
    selectedSsid,
    result,
    robotLanIp,
    startScanning,
    rescan,
    selectDevice,
    submitPin,
    rescanWifi,
    selectNetwork,
    submitPassword,
    commitName,
    finishNaming,
    linkAccount,
    retry,
    reset,
    goBack,
    canGoBack,
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
