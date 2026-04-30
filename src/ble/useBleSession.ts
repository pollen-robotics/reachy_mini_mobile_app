/**
 * Persistent BLE session store + hook.
 *
 * Owns the one-and-only BLE connection for the entire app. Mirrors the
 * desktop app's `useBluetooth.ts` pattern, adapted to the mobile flow:
 *
 *   1. `startScanning()` kicks the plugin's scan; discovered Reachy
 *      devices stream into `devices` (filtered by name).
 *   2. User taps a robot -> `connectToDevice(address)` stops the scan
 *      and opens a single BLE connection.
 *   3. That connection stays open while the user is inside the
 *      WiFi-setup screen. Every BLE command (PIN_*, WIFI_*, ...) goes
 *      through `sendCommand()` which serialises writes on the session
 *      via a promise chain so we never interleave request/response
 *      pairs.
 *   4. `disconnectDevice()` closes the session when the user leaves
 *      the flow (or after a successful WIFI_CONNECT).
 *
 * Why Zustand rather than a plain `useState` hook:
 *   * The session is a true global singleton (the plugin keeps one live
 *     connection, the daemon tracks a single authenticated client), so
 *     multiple screens navigating in/out of the flow need to see the
 *     same status. Zustand gives us that for free while keeping the
 *     API hook-shaped for the components.
 *   * Scan listeners and the command queue are module-scope (the plugin
 *     only accepts one handler per event), which already required
 *     external state - Zustand unifies it.
 */

import { create } from 'zustand';
import {
  checkPermissions as blecCheckPermissions,
  connect as blecConnect,
  disconnect as blecDisconnect,
  startScan,
  stopScan,
  getAdapterState,
  getConnectionUpdates,
  readString,
  sendString,
  type BleDevice,
} from '@mnlphlp/plugin-blec';

import {
  COMMAND_CHAR_UUID,
  CMD_SERVICE_UUID,
  NETWORK_STATUS_CHAR_UUID,
  REACHY_NAME_SUBSTRING,
  RESPONSE_CHAR_UUID,
  RESPONSE_READ_DELAY_MS,
  SCAN_TIMEOUT_MS,
  STATUS_SERVICE_UUID,
} from './constants';
import { parseAdvertManufacturerData } from './parseAdvertManufacturerData';
import { createLogger } from '../logger';

const logger = createLogger('ble');

// ===========================================================================
// Types
// ===========================================================================

/**
 * High-level session state machine. Matches the screens: the UI shows a
 * scan list in `idle` / `scanning`, a spinner in `connecting`, the WiFi
 * setup flow in `connected`, and an error banner in `error`.
 */
export type BleSessionStatus =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'error';

export interface ReachyBleDevice {
  /** Plugin address (macOS UUID, Linux MAC, Android MAC, iOS UUID). */
  address: string;
  /** Advertised local name (`ReachyMini`, `reachy-mini-xxxx`, ...). */
  name: string;
  /** RSSI from the last advertisement; useful for UI sorting later. */
  rssi: number;
  /** Unix ms of the last advertisement seen. Advertisements come in
   * bursts, so this lets us age-out entries if needed. */
  lastSeenMs: number;
  /**
   * First 16 hex chars of the daemon's install_id, decoded from the
   * advertisement's ManufacturerData TLV (Pollen company id 0xFFFF,
   * tag 0x01). ``null`` when the device is running an older daemon
   * (no install_id TLV in the advert) or when the parser rejects a
   * malformed payload. The mobile registry uses this prefix to
   * dedupe a BLE row against the same physical robot's localhost
   * loopback row + (eventually) its central listing without having
   * to GATT-connect first.
   */
  installIdPrefix: string | null;
  /**
   * First 16 hex chars of the relay-assigned central peerId,
   * decoded from the advertisement's ManufacturerData TLV (tag
   * 0x02). ``null`` when the central relay is offline on the
   * daemon side, or when the device is running an older daemon
   * that doesn't publish this TLV. Used as a dedup key against
   * the central listing's ``peerId`` while the central server
   * still strips ``meta.install_id``.
   */
  centralPeerIdPrefix: string | null;
  /**
   * Daemon-reported local network mode, decoded from BLE TLV 0x03.
   *
   *   - ``'connected'`` - daemon has a real LAN/WAN IP (Wi-Fi
   *     joined OR USB-tether interface up). Setup is done.
   *   - ``'hotspot'``   - daemon is broadcasting its own AP
   *     (10.42.0.1 fallback). Setup is NOT done.
   *   - ``'offline'``   - daemon has no IPv4 anywhere. Setup is
   *     incomplete or the network just dropped.
   *   - ``null``        - the BLE advert didn't carry the TLV
   *     (legacy daemon).
   *
   * Authoritative for "is Wi-Fi setup done?" because the daemon
   * derives it locally from ``ip -4 addr``, no central / Internet
   * dependency. Prefer this over inferring from
   * ``centralPeerIdPrefix`` presence.
   */
  networkMode: 'connected' | 'hotspot' | 'offline' | null;
}

// ===========================================================================
// Command queue (module-scope so it survives re-renders)
// ===========================================================================

/**
 * Serialise BLE writes+reads. The plugin is synchronous per call, but
 * the Reachy daemon uses a single shared response characteristic, so two
 * concurrent `sendString` calls would race on the read-back. A promise
 * chain gives us a FIFO queue for free.
 */
let commandQueue: Promise<unknown> = Promise.resolve();

async function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const prev = commandQueue;
  let release!: () => void;
  const next = new Promise<void>(resolve => {
    release = resolve;
  });
  commandQueue = prev.then(() => next);
  try {
    await prev;
  } catch {
    // Ignore: we want this task to run regardless of the previous one's fate.
  }
  try {
    return await task();
  } finally {
    release();
  }
}

// ===========================================================================
// Store
// ===========================================================================

export interface NetworkStatus {
  hostname: string;
  ip: string | null;
  port: number;
  /** Free-form mode string as advertised by the daemon (`connected`,
   * `hotspot`, `offline`, ...). We don't enumerate it here because the
   * daemon may add new modes in future firmwares; consumers match
   * against known values and fall back to "unknown". */
  mode: string;
}

interface BleSessionState {
  status: BleSessionStatus;
  devices: Record<string, ReachyBleDevice>;
  connectedAddress: string | null;
  /**
   * Metadata of the last device the user selected from the scan list.
   * Survives across `startScanning()` calls so the WiFi screen can
   * keep showing the robot name even when the scan cache was wiped.
   */
  selectedDevice: ReachyBleDevice | null;
  /**
   * Cached snapshot of the last `NETWORK_STATUS` read. Populated
   * automatically after each successful `connectToDevice()` so the UI
   * can branch on `mode === 'connected'` without waiting for the
   * authenticated `WIFI_STATUS` poll to land.
   */
  networkStatus: NetworkStatus | null;
  error: string | null;
  adapterUnavailable: boolean;
  /** Opaque counter bumped each time listeners (connection, adapter, ...) were
   * wired. Lets the hook wire them exactly once via `initListeners()`. */
  listenersWired: boolean;
}

interface BleSessionActions {
  initListeners: () => Promise<void>;
  /**
   * Trigger a BLE scan burst (`SCAN_TIMEOUT_MS`). By default the
   * device list is reset first. Pass `{ preserve: true }` for a
   * continuous-scan pattern: previously-found robots are kept so the
   * UI doesn't flash empty between bursts.
   */
  startScanning: (options?: { preserve?: boolean }) => Promise<void>;
  stopScanning: () => Promise<void>;
  /**
   * Stop the scan, connect to the given device, and record it as the
   * current `selectedDevice`. Resolves `true` on success.
   */
  connectToDevice: (device: ReachyBleDevice) => Promise<boolean>;
  disconnectDevice: () => Promise<void>;
  sendCommand: (command: string, options?: { delayMs?: number }) => Promise<string>;
  /**
   * Read the daemon's `NETWORK_STATUS` characteristic (no-auth, JSON).
   * Returns a fresh snapshot of the robot's network state - notably
   * its IPv4 address when it is `mode=connected`. Throws if not
   * connected or if the payload is malformed.
   */
  readNetworkStatus: () => Promise<NetworkStatus>;
  clearError: () => void;
}

type BleSessionStore = BleSessionState & BleSessionActions;

export const useBleSessionStore = create<BleSessionStore>((set, get) => ({
  status: 'idle',
  devices: {},
  connectedAddress: null,
  selectedDevice: null,
  networkStatus: null,
  error: null,
  adapterUnavailable: false,
  listenersWired: false,

  initListeners: async () => {
    if (get().listenersWired) return;
    // Flip early so concurrent callers (screens racing to mount) don't
    // double-register.
    set({ listenersWired: true });
    try {
      await getConnectionUpdates(connected => {
        if (!connected) {
          set({ connectedAddress: null, status: 'idle' });
        }
      });
    } catch (e) {
      console.warn('[ble] getConnectionUpdates failed', e);
    }
    try {
      const state = await getAdapterState();
      set({ adapterUnavailable: state !== 'On' });
    } catch {
      set({ adapterUnavailable: true });
    }
  },

  startScanning: async (options?: { preserve?: boolean }) => {
    if (options?.preserve) {
      set({ error: null, status: 'scanning' });
    } else {
      set({ error: null, devices: {}, status: 'scanning' });
    }
    await get().initListeners();
    // Android 12+ requires runtime grants for BLUETOOTH_SCAN and
    // BLUETOOTH_CONNECT. The plugin's own `startScan` does check
    // permissions but with `askIfDenied=false`, which means a fresh
    // install fails silently before the user ever sees the system
    // prompt. We force the prompt cascade up-front. iOS and desktop
    // builds resolve `true` synchronously without any user-visible
    // side effect (CoreBluetooth on iOS prompts on first scan; desktop
    // platforms have no runtime permission system here).
    try {
      const granted = await blecCheckPermissions(true);
      if (!granted) {
        logger.warn('scan.permissions_denied');
        set({
          status: 'error',
          error: 'Bluetooth permission denied. Enable it in system settings.',
        });
        return;
      }
    } catch (err) {
      // The Android plugin returns a meaningful error when the adapter
      // is unavailable (no BLE hardware in an emulator, for instance).
      // On other platforms this should never throw.
      logger.warn('scan.permissions_check_failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info('scan.start', { preserve: options?.preserve === true });
    try {
      const handle = startScan((found: BleDevice[]) => {
        const next = { ...get().devices };
        let changed = false;
        for (const raw of found) {
          const name = raw.name?.trim();
          if (!name) continue;
          const normalized = name.toLowerCase().replace(/-/g, '');
          if (!normalized.includes(REACHY_NAME_SUBSTRING)) continue;
          const advert = parseAdvertManufacturerData(raw.manufacturerData);
          if (!(raw.address in next)) {
            logger.info('scan.discovered', {
              name,
              address: raw.address,
              rssi: raw.rssi ?? 0,
              installIdPrefix: advert.installIdPrefix,
              centralPeerIdPrefix: advert.centralPeerIdPrefix,
              networkMode: advert.networkMode,
            });
          }
          // Re-emit the row only when something visible to the UI
          // (rssi, name) or to the dedup logic (install_id prefix,
          // central peerId prefix, network mode) actually changed,
          // otherwise we churn the Zustand store on every advert
          // burst.
          const prev = next[raw.address];
          const nextRow: ReachyBleDevice = {
            address: raw.address,
            name,
            rssi: raw.rssi ?? 0,
            lastSeenMs: Date.now(),
            installIdPrefix: advert.installIdPrefix,
            centralPeerIdPrefix: advert.centralPeerIdPrefix,
            networkMode: advert.networkMode,
          };
          next[raw.address] = nextRow;
          if (
            !prev ||
            prev.rssi !== nextRow.rssi ||
            prev.name !== nextRow.name ||
            prev.installIdPrefix !== nextRow.installIdPrefix ||
            prev.centralPeerIdPrefix !== nextRow.centralPeerIdPrefix ||
            prev.networkMode !== nextRow.networkMode
          ) {
            changed = true;
          }
        }
        if (changed) set({ devices: next });
      }, SCAN_TIMEOUT_MS);
      handle.catch(err => {
        // Windows + some Linux adapters resolve the handle with an
        // error object instead of throwing synchronously. Surface it.
        console.warn('[ble] startScan rejected', err);
        const msg = formatBlecError(err);
        if (msg) set({ error: msg });
      });
    } catch (err) {
      set({ status: 'error', error: formatBlecError(err) });
      return;
    }
    // Bounce back to idle once the scan window elapses - unless we
    // moved forward to connecting in the meantime.
    window.setTimeout(() => {
      if (get().status === 'scanning') set({ status: 'idle' });
    }, SCAN_TIMEOUT_MS);
  },

  stopScanning: async () => {
    try {
      await stopScan();
    } catch {
      // Already stopped.
    }
    if (get().status === 'scanning') set({ status: 'idle' });
  },

  connectToDevice: async (device: ReachyBleDevice) => {
    // Flip both `selectedDevice` and `status: 'connecting'`
    // synchronously before any await so consumers that observe the
    // store right after `connectToDevice()` returns control (routing
    // pre-warm: `App.tsx` fires this then immediately navigates) see
    // a coherent "we're opening the link" state. If we set status
    // *after* the stopScan await, a screen that mounts in-between
    // would briefly see `status: 'idle'` and (in WifiSetupScreen)
    // bail out via its presence guard.
    set({
      error: null,
      selectedDevice: device,
      networkStatus: null,
      status: 'connecting',
    });
    // CoreBluetooth / btleplug require the scan to be stopped before a
    // connect. Do it unconditionally: the plugin treats `stopScan()`
    // as a no-op if nothing is running.
    try {
      await stopScan();
    } catch {
      // Ignore.
    }
    try {
      console.info('[ble] connecting to', device.name, device.address);
      logger.info('connect.start', { name: device.name, address: device.address });
      const t0 = performance.now();
      await blecConnect(device.address, () => {
        console.info('[ble] peripheral closed the connection');
        logger.info('disconnect', { reason: 'peripheral_closed' });
        set({ connectedAddress: null, status: 'idle', networkStatus: null });
      });
      set({ connectedAddress: device.address, status: 'connected' });
      logger.info('connect.success', {
        name: device.name,
        latency_ms: Math.round(performance.now() - t0),
      });
      console.info('[ble] connected, will read NETWORK_STATUS');
      // Best-effort read of NETWORK_STATUS right after the connect.
      // The read itself is fire-and-forget for `connectToDevice`'s
      // caller: the `TransitionScreen` does an explicit
      // `readNetworkStatus()` with visible retries and uses THAT
      // outcome to route. Doing it here too primes the store so the
      // transition screen can render immediately.
      try {
        const ns = await readNetworkStatusWithRetry(2);
        set({ networkStatus: ns });
        console.info('[ble] NETWORK_STATUS (post-connect) =', ns);
      } catch (e) {
        console.warn('[ble] NETWORK_STATUS read after connect failed', e);
      }
      return true;
    } catch (err) {
      const msg = formatBlecError(err);
      console.warn('[ble] connect failed', msg, err);
      logger.warn('connect.failure', { name: device.name, message: msg });
      set({ error: msg, status: 'error', connectedAddress: null });
      return false;
    }
  },

  disconnectDevice: async () => {
    set({ status: 'disconnecting' });
    logger.info('disconnect.start');
    try {
      await blecDisconnect();
    } catch (err) {
      console.warn('[ble] disconnect error', err);
      logger.warn('disconnect.error', { message: formatBlecError(err) });
    }
    set({ connectedAddress: null, status: 'idle' });
    logger.info('disconnect.complete');
  },

  sendCommand: async (command: string, options) => {
    const { connectedAddress } = get();
    if (!connectedAddress) {
      throw new Error('Not connected to any robot.');
    }
    const delay = options?.delayMs ?? RESPONSE_READ_DELAY_MS;
    return runExclusive(async () => {
      await sendString(COMMAND_CHAR_UUID, command, 'withoutResponse', CMD_SERVICE_UUID);
      if (delay > 0) await sleep(delay);
      return await readString(RESPONSE_CHAR_UUID, CMD_SERVICE_UUID);
    });
  },

  readNetworkStatus: async () => {
    if (!get().connectedAddress) {
      throw new Error('Not connected to any robot.');
    }
    const ns = await readNetworkStatusWithRetry(3);
    set({ networkStatus: ns });
    return ns;
  },

  clearError: () => set({ error: null }),
}));

/**
 * Raw NETWORK_STATUS read. Lives outside the store action so the
 * `connectToDevice` post-connect probe can reuse it without bouncing
 * through the store's get/set machinery.
 *
 * The daemon exposes this characteristic as a **plain-text** string,
 * NOT JSON. Source of truth:
 *   reachy_mini/src/reachy_mini/daemon/app/services/bluetooth/bluetooth_service.py
 * in `get_network_status()`. Format:
 *
 *   "{MODE} [iface] ip ; [iface] ip"   e.g. "CONNECTED [wlan0] 192.168.1.19"
 *   "OFFLINE"                          (no interfaces up)
 *   "ERROR"                            (daemon failed to enumerate)
 *
 * MODE ∈ {CONNECTED, HOTSPOT, OFFLINE}. HOTSPOT means wlan0 is the
 * access point (10.42.0.1) - the robot is NOT on a routable network.
 */
async function readNetworkStatusInternal(): Promise<NetworkStatus> {
  // NETWORK_STATUS is a plain read on the STATUS service; it does not
  // go through the command/response protocol, so we bypass the
  // command queue (no write to serialise against).
  const raw = (await readString(NETWORK_STATUS_CHAR_UUID, STATUS_SERVICE_UUID)).trim();
  const ns = parseNetworkStatus(raw);
  if (!ns) {
    throw new Error(`Unexpected NETWORK_STATUS payload: ${raw}`);
  }
  return ns;
}

/**
 * Parse the daemon's plain-text NETWORK_STATUS payload.
 *
 * Rules:
 *   - Empty / "ERROR" payloads → null (caller should retry).
 *   - "OFFLINE" (no interfaces) → mode='offline', ip=null.
 *   - "HOTSPOT [wlan0] 10.42.0.1" → mode='hotspot', ip=10.42.0.1.
 *     The IP is technically reachable (if you're on the robot's AP)
 *     but the HTTP probe will decide that.
 *   - "CONNECTED [wlan0] 192.168.1.19 ; [eth0] 10.0.0.5" → mode='connected',
 *     ip picked from wlan0 > eth0 > first-listed interface.
 *
 * Exported for unit testing; not used elsewhere at runtime.
 */
export function parseNetworkStatus(raw: string): NetworkStatus | null {
  if (!raw || raw === 'ERROR') return null;

  // Head word is the mode, rest is interface list. Split on first whitespace.
  const firstSpace = raw.indexOf(' ');
  const head = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : raw.slice(firstSpace + 1).trim();
  const mode = head.toLowerCase();

  if (rest.length === 0) {
    // Just "OFFLINE" or any other bare mode - no IP yet.
    return { hostname: '', ip: null, port: 8000, mode };
  }

  // Interface entries are separated by " ; "; each entry looks like
  // "[wlan0] 192.168.1.19". We tolerate missing spaces / extra
  // whitespace since the format is hand-built on the daemon side.
  const entries = rest
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const interfaces: Array<{ iface: string; ip: string }> = [];
  for (const entry of entries) {
    const match = entry.match(/^\[([^\]]+)\]\s*(\S+)/);
    if (match && match[1] && match[2]) {
      interfaces.push({ iface: match[1], ip: match[2] });
    }
  }

  // Prefer wlan0, then eth0, then whatever the daemon listed first.
  const preferred =
    interfaces.find(i => i.iface === 'wlan0') ??
    interfaces.find(i => i.iface === 'eth0') ??
    interfaces[0] ??
    null;

  return {
    hostname: '',
    ip: preferred?.ip ?? null,
    port: 8000,
    mode,
  };
}

/**
 * Retry wrapper for NETWORK_STATUS reads. CoreBluetooth sometimes
 * returns a "characteristic not yet discovered" or a transient error
 * immediately after connect, so we wait a beat and retry rather than
 * failing the user over a 200 ms race.
 */
async function readNetworkStatusWithRetry(attempts: number): Promise<NetworkStatus> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      // Back off a bit: 250ms, 500ms, 1000ms...
      await sleep(250 * Math.pow(2, i - 1));
    }
    try {
      const ns = await readNetworkStatusInternal();
      return ns;
    } catch (e) {
      lastErr = e;
      console.warn(`[ble] NETWORK_STATUS read attempt ${i + 1}/${attempts} failed:`, e);
    }
  }
  throw lastErr ?? new Error('NETWORK_STATUS read failed');
}

// ===========================================================================
// Public hook API
// ===========================================================================

export interface UseBleSessionResult {
  status: BleSessionStatus;
  devices: ReachyBleDevice[];
  connectedAddress: string | null;
  selectedDevice: ReachyBleDevice | null;
  /** Last NETWORK_STATUS snapshot; populated right after connect and
   * refreshed whenever `readNetworkStatus()` is called explicitly. */
  networkStatus: NetworkStatus | null;
  error: string | null;
  adapterUnavailable: boolean;

  startScanning: (options?: { preserve?: boolean }) => Promise<void>;
  stopScanning: () => Promise<void>;
  connectToDevice: (device: ReachyBleDevice) => Promise<boolean>;
  disconnectDevice: () => Promise<void>;
  sendCommand: (command: string, options?: { delayMs?: number }) => Promise<string>;
  readNetworkStatus: () => Promise<NetworkStatus>;
  clearError: () => void;
}

/**
 * Read-only selectors + bound actions. Returns a stable shape so
 * component prop drilling works without surprising re-renders.
 */
export function useBleSession(): UseBleSessionResult {
  const status = useBleSessionStore(s => s.status);
  const devicesMap = useBleSessionStore(s => s.devices);
  const connectedAddress = useBleSessionStore(s => s.connectedAddress);
  const selectedDevice = useBleSessionStore(s => s.selectedDevice);
  const networkStatus = useBleSessionStore(s => s.networkStatus);
  const error = useBleSessionStore(s => s.error);
  const adapterUnavailable = useBleSessionStore(s => s.adapterUnavailable);

  const startScanning = useBleSessionStore(s => s.startScanning);
  const stopScanning = useBleSessionStore(s => s.stopScanning);
  const connectToDevice = useBleSessionStore(s => s.connectToDevice);
  const disconnectDevice = useBleSessionStore(s => s.disconnectDevice);
  const sendCommand = useBleSessionStore(s => s.sendCommand);
  const readNetworkStatus = useBleSessionStore(s => s.readNetworkStatus);
  const clearError = useBleSessionStore(s => s.clearError);

  const devices = Object.values(devicesMap).sort((a, b) => {
    if (b.rssi !== a.rssi) return b.rssi - a.rssi;
    return a.name.localeCompare(b.name);
  });

  return {
    status,
    devices,
    connectedAddress,
    selectedDevice,
    networkStatus,
    error,
    adapterUnavailable,
    startScanning,
    stopScanning,
    connectToDevice,
    disconnectDevice,
    sendCommand,
    readNetworkStatus,
    clearError,
  };
}

/** Initialise plugin listeners at the app root (call once from `<App />`). */
export function useInitBleListeners(): void {
  const init = useBleSessionStore(s => s.initListeners);
  // Run once on mount; Zustand actions are stable.
  useOnceEffect(() => {
    void init();
  });
}

// ===========================================================================
// Helpers
// ===========================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export function formatBlecError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    // The plugin surfaces errors as `{ kind, message }` on some platforms.
    const anyErr = err as { message?: unknown };
    if (typeof anyErr.message === 'string') return anyErr.message;
    try {
      return JSON.stringify(err);
    } catch {
      // Fall through.
    }
  }
  return String(err);
}

// Tiny `useEffect(..., [])` wrapper that survives React strict-mode's
// effect double-invocation (since the ref-guard is stable across remounts).
import { useEffect, useRef } from 'react';
function useOnceEffect(fn: () => void): void {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    fn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
