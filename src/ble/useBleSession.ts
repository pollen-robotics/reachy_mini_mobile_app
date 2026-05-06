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
import { parseNetworkStatus, type NetworkStatus } from './networkStatus';
import { parseAdvertHardwareId } from './parseAdvertPayload';

export { parseNetworkStatus };
export type { NetworkStatus };

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
   * Stable per-robot identity, parsed from the daemon's BLE
   * advertisement manufacturer data (TLV v0x02, tag 0x01) at scan
   * time. Same value as the daemon's `meta.hardware_id` on its
   * central listing and `hardware_id` from `GET /api/daemon/status`,
   * so the picker can dedupe a BLE row against the same robot's
   * Local USB / Distant rows on a single key.
   *
   * `null` when the advert does not carry it yet - either the daemon
   * is older than the TLV-format change (#1085) or no Reachy is
   * attached (the daemon omits the manufacturer data in that case).
   * Consumers MUST NOT invent a tag from another id space here:
   * leave the chip empty rather than pretend.
   */
  hardwareId: string | null;
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
   * Record a device as the user's current selection without opening
   * the BLE link. Used by the picker on the scan screen so the next
   * route (`WifiSetupScreen`) reads a non-null `selectedDevice` from
   * the store and can drive the actual `connectToDevice()` itself.
   *
   * Separating selection from connection keeps the BLE write
   * lifecycle owned by exactly one screen at a time and avoids a
   * race where the picker connects in the background while the
   * setup screen is also trying to.
   */
  selectDevice: (device: ReachyBleDevice) => void;
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
    try {
      const handle = startScan((found: BleDevice[]) => {
        const next = { ...get().devices };
        let changed = false;
        for (const raw of found) {
          const name = raw.name?.trim();
          if (!name) continue;
          const normalized = name.toLowerCase().replace(/-/g, '');
          if (!normalized.includes(REACHY_NAME_SUBSTRING)) continue;
          // The daemon embeds `hardware_id` in its BLE manufacturer
          // data (TLV v0x02, tag 0x01). Parse it on every burst so
          // a late-joining hwid (e.g. audio device hot-plugged after
          // boot) propagates without a reconnect, and prefer a freshly
          // parsed value over the previous one - if both fail to
          // parse, we hold on to whatever we had so we don't flap.
          const previous = next[raw.address];
          const parsedHwid = parseAdvertHardwareId(raw.manufacturerData);
          next[raw.address] = {
            address: raw.address,
            name,
            rssi: raw.rssi ?? 0,
            lastSeenMs: Date.now(),
            hardwareId: parsedHwid ?? previous?.hardwareId ?? null,
          };
          changed = true;
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

  selectDevice: (device: ReachyBleDevice) => {
    // Pure assignment: do NOT touch `connectedAddress` or
    // `networkStatus`. The next `connectToDevice` (typically fired by
    // the screen we are about to navigate to) will reset them when
    // the actual link opens.
    set({ selectedDevice: device, error: null });
  },

  connectToDevice: async (device: ReachyBleDevice) => {
    set({ error: null, selectedDevice: device, networkStatus: null });
    // CoreBluetooth / btleplug require the scan to be stopped before a
    // connect. Do it unconditionally: the plugin treats `stopScan()`
    // as a no-op if nothing is running.
    try {
      await stopScan();
    } catch {
      // Ignore.
    }
    set({ status: 'connecting' });
    try {
      console.info('[ble] connecting to', device.name, device.address);
      await blecConnect(device.address, () => {
        console.info('[ble] peripheral closed the connection');
        set({ connectedAddress: null, status: 'idle', networkStatus: null });
      });
      set({ connectedAddress: device.address, status: 'connected' });
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
      // No post-connect HARDWARE_ID read here: the scan callback
      // already parsed it from the manufacturer data (TLV v0x02,
      // tag 0x01) and assigned `device.hardwareId` synchronously.
      // If that came back null, it means the daemon is older than
      // PR-1085 or has no Reachy attached - either way, a GATT read
      // would buy us nothing the parser hasn't already established.
      return true;
    } catch (err) {
      const msg = formatBlecError(err);
      console.warn('[ble] connect failed', msg, err);
      set({ error: msg, status: 'error', connectedAddress: null });
      return false;
    }
  },

  disconnectDevice: async () => {
    set({ status: 'disconnecting' });
    try {
      await blecDisconnect();
    } catch (err) {
      console.warn('[ble] disconnect error', err);
    }
    set({ connectedAddress: null, status: 'idle' });
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
  selectDevice: (device: ReachyBleDevice) => void;
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
  const selectDevice = useBleSessionStore(s => s.selectDevice);
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
    selectDevice,
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
