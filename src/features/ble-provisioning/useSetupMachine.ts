/**
 * First-time setup state machine.
 *
 * Drives the BLE Wi-Fi provisioning wizard end to end:
 *
 *   scanning → connecting → pin → authenticating → wifi-scanning → wifi-pick
 *     → wifi-connecting → linking-account → central-waiting → done
 *
 * Account linking (robot-side HF OAuth) is the last human step: once the robot
 * registers on central the flow settles to sleep and finishes. Naming the robot
 * now happens in the first wake-up wizard (over the live session), not here, so
 * the BLE flow ends the moment the robot is online. The "settle to sleep" end
 * cue still plays on the way to `done` so the wake-up wizard's "Tuck Me In"
 * step starts from a robot placed exactly in its sleep pose.
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
  IDENTIFY_SOUND,
  MIN_WIFI_SETUP_VERSION,
  RobotOutdatedError,
  WAITING_MOVE,
  authenticate,
  connectSealed,
  gotoSleep,
  keyExchange,
  play,
  playSound,
  readIdentity,
  readNetworkInfo,
  scanWifi,
  toSetupError,
  wifiStatus,
} from './protocol';
import { openExternalUrl } from '@/shared/tauri/openUrl';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
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
// token, and start the central relay. We reach the robot STRICTLY by the LAN
// IP read over BLE — mDNS (`reachy-mini.local`) is unreliable on mobile /
// WKWebView and buys nothing here (setup always happens on the phone's own
// network), so there is no hostname fallback: a missing IP is a hard error.
// The phone must be on the robot's Wi-Fi for HF to redirect back.
function robotOAuthBeginUrl(ip: string): string {
  return `http://${ip}:8000/api/hf-auth/oauth/begin`;
}

// ── Device-code OAuth (RFC 8628): redirect-free, mDNS-free HF sign-in ────────
// The robot polls Hugging Face directly, so NOTHING has to be reachable at a
// fixed hostname (`reachy-mini.local`) and there is no HF→robot callback: the
// phone just opens HF's device page and the robot fetches the token itself.
// This is the preferred path. It exists only on daemons that expose
// `/api/hf-auth/oauth/device/*` (v1.10+); on older daemons `startDeviceCode`
// returns `null` and `linkAccount` falls back to the legacy `/oauth/begin`
// redirect flow (whose callback still hits `reachy-mini.local` — the residual
// mDNS dependency we can't retrofit onto already-shipped robots). Both flows
// talk to the robot STRICTLY by the LAN IP read over BLE.
interface DeviceCodeStart {
  sessionId: string;
  userCode: string;
  /** HF page to open (`verification_uri`), used as the manual "open again" link. */
  verificationUri: string;
  /** Same page with `?user_code=…` pre-filled (`verification_uri_complete`). */
  verificationUriComplete: string;
  /** Poll cadence, floored so a tiny value can't hammer the robot. */
  intervalMs: number;
  /** How long the user has to authorize before the code expires. */
  expiresInMs: number;
}

type DeviceCodeStatus = 'pending' | 'authorized' | 'error' | 'expired' | 'cancelled';

const DEVICE_POLL_MIN_INTERVAL_MS = 2_000;
// Hard ceiling on the browser-authorize wait, even if HF advertises longer.
const DEVICE_AUTH_TIMEOUT_MS = 300_000;

function robotDeviceBase(ip: string): string {
  return `http://${ip}:8000/api/hf-auth/oauth/device`;
}

// POST the robot's device-start endpoint. Returns `null` when the route is
// absent (older daemon → caller uses the legacy begin flow). Throws on
// transport / server errors (robot unreachable, HF failed to issue a code) so
// the caller surfaces an explicit failure instead of a fake success.
async function startDeviceCode(ip: string): Promise<DeviceCodeStart | null> {
  const resp = await tauriFetch(`${robotDeviceBase(ip)}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  // Route doesn't exist on daemons predating the device-code flow.
  if (resp.status === 404 || resp.status === 405) return null;
  if (!resp.ok) throw new Error(`device/start failed (HTTP ${resp.status})`);
  const data = (await resp.json()) as {
    status?: string;
    session_id?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
    message?: string;
  };
  if (data.status === 'error' || !data.session_id || !data.user_code) {
    throw new Error(data.message ?? 'The robot could not start Hugging Face sign-in.');
  }
  const verificationUri = data.verification_uri ?? 'https://huggingface.co/oauth/device';
  return {
    sessionId: data.session_id,
    userCode: data.user_code,
    verificationUri,
    verificationUriComplete: data.verification_uri_complete ?? verificationUri,
    intervalMs: Math.max((data.interval ?? 5) * 1000, DEVICE_POLL_MIN_INTERVAL_MS),
    expiresInMs: Math.min((data.expires_in ?? 900) * 1000, DEVICE_AUTH_TIMEOUT_MS),
  };
}

async function getDeviceStatus(ip: string, sessionId: string): Promise<DeviceCodeStatus> {
  const resp = await tauriFetch(`${robotDeviceBase(ip)}/status/${sessionId}`, { method: 'GET' });
  if (!resp.ok) throw new Error(`device/status failed (HTTP ${resp.status})`);
  const data = (await resp.json()) as { status?: string };
  return (data.status as DeviceCodeStatus) ?? 'pending';
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
  networks: string[];
  selectedSsid: string | null;
  result: SetupResult | null;
  /** LAN IP the robot got after joining Wi-Fi, discovered over BLE. `null`
   *  until known (or if it couldn't be read — account linking then errors out
   *  with `robot-ip-unknown`, since we never fall back to mDNS). */
  robotLanIp: string | null;
  /** Device-code shown to the user during `device-code-waiting` (redirect-free
   *  HF sign-in). `null` outside that phase / on the legacy begin flow. */
  deviceUserCode: string | null;
  /** HF verification URL for the device-code flow (backup "open again" link).
   *  `null` outside the device-code flow. */
  deviceVerificationUri: string | null;

  // actions
  startScanning: () => void;
  rescan: () => void;
  selectDevice: (device: BleDevice) => void;
  submitPin: (pin: string) => void;
  rescanWifi: () => void;
  selectNetwork: (ssid: string) => void;
  submitPassword: (password: string, ssid?: string) => void;
  /** Robot already on Wi-Fi: skip provisioning, jump to account linking. */
  skipWifiSetup: () => void;
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
  // The wizard opens straight on the scan step: there's no separate intro or
  // permission screen - the OS Bluetooth permission prompt is raised by the
  // scan attempt itself (see `startScanning`'s error handling).
  const [phase, setPhase] = useState<SetupPhase>('scanning');
  const [error, setError] = useState<SetupError | null>(null);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [networks, setNetworks] = useState<string[]>([]);
  const [selectedSsid, setSelectedSsid] = useState<string | null>(null);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [robotLanIp, setRobotLanIp] = useState<string | null>(null);
  const [deviceUserCode, setDeviceUserCode] = useState<string | null>(null);
  const [deviceVerificationUri, setDeviceVerificationUri] = useState<string | null>(null);

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
          // Play the identify chirp (sound only, no motion) so the user hears
          // which physical Reachy they just tapped. Public BLE command (no
          // PIN). Kept SEQUENTIAL on the shared command/response channel (a
          // concurrent sendCommand would flush the notification backlog and
          // could collide with the PIN step); best-effort so a failed cue
          // never blocks setup.
          await playSound(IDENTIFY_SOUND);
          if (runId !== runIdRef.current || !mountedRef.current) return;
          const id = await readIdentity();
          if (runId !== runIdRef.current || !mountedRef.current) return;
          // Keep only in a ref: the hardware id is read later by `linkAccount`
          // to match the robot on central. Nothing in the UI renders it.
          identityRef.current = id;
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

          // Fast path: if the robot is ALREADY on a Wi-Fi network there's
          // nothing to provision. Reading its live status over BLE lets us
          // offer to skip straight to account linking - and it's the natural
          // path for "just re-link Hugging Face" on an already-online robot.
          // Best-effort: any hiccup falls through to the normal Wi-Fi scan.
          try {
            const status = await wifiStatus();
            if (runId !== runIdRef.current || !mountedRef.current) return;
            if (status.connected) {
              setSelectedSsid(status.connected);
              // Read the LAN IP now so the skip path can hand OAuth a literal
              // IP (same route as the post-join flow). A null IP here means
              // `linkAccount` will fail fast with `robot-ip-unknown` (we never
              // fall back to mDNS).
              robotIpRef.current = null;
              setRobotLanIp(null);
              try {
                const net = await readNetworkInfo();
                if (runId !== runIdRef.current || !mountedRef.current) return;
                if (net.mode === 'connected' && net.ip) {
                  robotIpRef.current = net.ip;
                  setRobotLanIp(net.ip);
                }
              } catch {
                /* IP unread - linkAccount errors out (no mDNS fallback) */
              }
              setPhase('wifi-already-connected');
              return;
            }
          } catch {
            /* status unread - fall through to the normal Wi-Fi scan */
          }

          // Not on Wi-Fi yet: chain straight into the Wi-Fi scan.
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

  // Selecting a network doesn't advance to a separate password phase: the pick
  // view expands the chosen SSID inline (accordion) and owns the password entry,
  // so both live in the single `wifi-pick` step. We still record the SSID so
  // `submitPassword` (and the wrong-password recovery) has it even without an
  // explicit argument.
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
          // poll briefly until it reports `connected` with an address. If it
          // never lands, the IP stays null and `linkAccount` fails fast with
          // `robot-ip-unknown` (we never fall back to mDNS).
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
            if (Date.now() > ipDeadline) break; // give up; linkAccount errors
            await sleep(IP_POLL_INTERVAL_MS);
            if (runId !== runIdRef.current || !mountedRef.current) return;
          }

          // Cue the "waiting" idle again while the account-link step is up
          // (sequential: the IP poll above has finished, nothing else holds the
          // BLE channel).
          await play(WAITING_MOVE);
          if (runId !== runIdRef.current || !mountedRef.current) return;

          // Joined Wi-Fi → hand off to robot-side HF OAuth, the last human step
          // of setup, so the robot comes fully online and registers on central
          // before we finish. (Naming now happens later, in the first wake-up
          // wizard over the live session.)
          setPhase('linking-account');
        } catch (e) {
          if (runId !== runIdRef.current || !mountedRef.current) return;
          fail((e as Error).message ?? String(e), 'wifi-pick');
        }
      })();
    },
    [selectedSsid, fail],
  );

  // Robot is already on Wi-Fi (see the `wifi-already-connected` branch in
  // `submitPin`): skip provisioning entirely and go straight to HF account
  // linking, reusing the SSID + LAN IP already read over BLE. "Use a different
  // network" instead routes to `rescanWifi` (the normal pick flow).
  const skipWifiSetup = useCallback(() => {
    runIdRef.current += 1;
    setError(null);
    setPhase('linking-account');
  }, []);

  // ── ACCOUNT LINK (robot-side OAuth) - the last human step ────────────────────

  // Link the robot to Hugging Face so it comes online and registers on central.
  // We reach the robot STRICTLY by the LAN IP read over BLE (no mDNS fallback);
  // a missing IP is a hard `robot-ip-unknown` failure so we never open an
  // unreachable `reachy-mini.local` URL and then pretend it worked.
  //
  // Two flows, feature-detected on the robot:
  //   - device-code (preferred, mDNS-free): the robot polls HF directly, so
  //     there is no HF→robot callback and nothing depends on `reachy-mini.local`.
  //     The phone opens HF's device page and we poll the robot for completion.
  //   - legacy `/oauth/begin` (older daemons only): the robot redirects to HF
  //     and HF calls back to `reachy-mini.local` — the residual mDNS dependency
  //     we can't retrofit onto already-shipped robots. Used only when the
  //     device-code route is absent (404).
  //
  // Either way, central appearance is the ONLY success signal (token stored →
  // relay up → registered). No match ⇒ `oauth-unconfirmed` (recoverable), never
  // a fake `done`. Right before `done` we fire the canonical goto-sleep
  // trajectory (the final BLE cue) so the first wake-up wizard, which opens on
  // "Tuck Me In", starts from a robot placed EXACTLY in its sleep pose. BLE is
  // still connected here (dropped on unmount), so we AWAIT the ack to guarantee
  // the write lands before `done`; best-effort so a failed cue never blocks.
  const linkAccount = useCallback(() => {
    const runId = (runIdRef.current += 1);
    setError(null);
    setDeviceUserCode(null);
    setDeviceVerificationUri(null);
    const ip = robotIpRef.current;
    if (!ip) {
      setError({
        code: 'robot-ip-unknown',
        message:
          "We couldn't read your Reachy's network address to finish signing in. " +
          'Make sure your phone is on the same Wi-Fi as the robot, then try again.',
        recoverPhase: 'linking-account',
      });
      setPhase('error');
      return;
    }
    const hwid = identityRef.current?.hardwareId ?? null;

    // Shared tail for both flows: confirm the robot registered on central, then
    // settle to sleep and finish. A `null` match is an unconfirmed sign-in.
    const confirmOnlineAndFinish = async (): Promise<void> => {
      const matched = await waitForCentral(token, hwid, runId, runIdRef, mountedRef);
      if (runId !== runIdRef.current || !mountedRef.current) return;
      if (!matched) {
        setError({
          code: 'oauth-unconfirmed',
          message:
            "We couldn't confirm your Reachy came online. Finish signing in " +
            'with Hugging Face in the browser (on the same Wi-Fi as the robot), ' +
            'then try again.',
          recoverPhase: 'linking-account',
        });
        setPhase('error');
        return;
      }
      setResult({ hardwareId: hwid, robot: matched });
      await gotoSleep();
      if (runId !== runIdRef.current || !mountedRef.current) return;
      setPhase('done');
    };

    void (async () => {
      try {
        // Prefer the redirect-free device-code flow. `null` ⇒ older daemon
        // without the route ⇒ legacy begin flow.
        let start: DeviceCodeStart | null = null;
        try {
          start = await startDeviceCode(ip);
        } catch (e) {
          // Couldn't probe the device-code route (blocked by the HTTP scope, a
          // transient blip, or an old daemon that errors instead of returning a
          // clean 404). Fall back to the legacy begin flow: it drives the robot
          // through the browser (opener), so it still works when our direct HTTP
          // probe can't reach the robot. Still IP-only — never `reachy-mini.local`.
          console.warn('[setup] device-code unavailable, using legacy begin flow:', e);
          start = null;
        }
        if (runId !== runIdRef.current || !mountedRef.current) return;

        if (start) {
          // ── device-code branch (mDNS-free) ──
          setDeviceUserCode(start.userCode);
          setDeviceVerificationUri(start.verificationUri);
          // Open HF's device page (public internet — no robot/mDNS dependency).
          // `_complete` pre-fills the code; we still show it in-app as a backup.
          await openExternalUrl(start.verificationUriComplete);
          if (runId !== runIdRef.current || !mountedRef.current) return;
          setPhase('device-code-waiting');

          const deadline = Date.now() + start.expiresInMs;
          for (;;) {
            await sleep(start.intervalMs);
            if (runId !== runIdRef.current || !mountedRef.current) return;
            let status: DeviceCodeStatus;
            try {
              status = await getDeviceStatus(ip, start.sessionId);
            } catch {
              // Transient poll blip: keep trying until the deadline.
              if (Date.now() > deadline) status = 'expired';
              else continue;
            }
            if (runId !== runIdRef.current || !mountedRef.current) return;
            if (status === 'authorized') break;
            if (status === 'error' || status === 'expired' || status === 'cancelled') {
              setError({
                code: 'oauth-unconfirmed',
                message:
                  "We couldn't confirm your Hugging Face sign-in. Open the page again, " +
                  'enter the code shown, then try again.',
                recoverPhase: 'linking-account',
              });
              setPhase('error');
              return;
            }
            if (Date.now() > deadline) {
              setError({
                code: 'oauth-unconfirmed',
                message:
                  'Sign-in timed out. Open the Hugging Face page again and enter the ' +
                  'code to finish, then try again.',
                recoverPhase: 'linking-account',
              });
              setPhase('error');
              return;
            }
          }
          // Authorized: the status route also brings the central relay up. Fall
          // through to the shared central confirmation to get the listing.
          setPhase('central-waiting');
          await confirmOnlineAndFinish();
          return;
        }

        // ── legacy branch (older daemon: mDNS callback) ──
        await openExternalUrl(robotOAuthBeginUrl(ip));
        if (runId !== runIdRef.current || !mountedRef.current) return;
        setPhase('central-waiting');
        await confirmOnlineAndFinish();
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
      return;
    }
    if (target === 'wifi-scanning') {
      // `wifi-scanning` is a transient busy state with no view of its own (its
      // BusyView just spins), so parking on it would strand the user on a dead
      // spinner. Re-run the actual scan instead - it re-sets the phase AND
      // fires `scanWifiResilient`, landing back on `wifi-pick`.
      rescanWifi();
      return;
    }
    // Re-enter the relevant step; the user re-performs the action (pin,
    // password, …). Bumping runId invalidates any stale chain.
    runIdRef.current += 1;
    setPhase(target);
  }, [error, startScanning, rescanWifi]);

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
      case 'wifi-already-connected':
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
      case 'device-code-waiting':
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
    setDeviceUserCode(null);
    setDeviceVerificationUri(null);
    setError(null);
    setScanning(false);
    setDevices([]);
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
    networks,
    selectedSsid,
    result,
    robotLanIp,
    deviceUserCode,
    deviceVerificationUri,
    startScanning,
    rescan,
    selectDevice,
    submitPin,
    rescanWifi,
    selectNetwork,
    submitPassword,
    skipWifiSetup,
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
 * when the robot never registered in time. A `null` is now treated by
 * `linkAccount` as an UNCONFIRMED OAuth (a recoverable error), not a success.
 *
 * When we have no hwid to match on we can't confirm at all, so we resolve
 * `null` quickly (after a short grace) rather than spinning the full timeout —
 * the caller then surfaces `oauth-unconfirmed` and the user retries. (This is
 * the honest outcome: without a hwid we have no signal that sign-in worked.)
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
