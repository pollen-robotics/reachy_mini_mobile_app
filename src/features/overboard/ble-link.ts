/**
 * Direct Bluetooth LE link to the overboard (manual mode) - STUB.
 *
 * Manual mode releases the robot's WebRTC session entirely, so the phone
 * has to talk to the overboard itself. The real implementation will sit
 * on `@mnlphlp/plugin-blec` (already used by `features/ble/`) and follow
 * the protocol of the `reachy_mini_wheels_app` Space: scan for the
 * overboard, connect, write drive frames to its command characteristic,
 * and read RSSI for the signal indicator.
 *
 * Until then this stub keeps the whole UI path honest: it walks through
 * the connection states, reports a SIMULATED RSSI (flagged as such so the
 * UI can label it), and logs the drive frames it would have written.
 */
import { emptyStats, type OverboardLink } from './link';

export type BleLinkState = 'idle' | 'scanning' | 'connected' | 'error';

export interface BleLinkSnapshot {
  state: BleLinkState;
  /** dBm, or null when unknown / not connected. */
  rssi: number | null;
  /** True while the values come from the stub, not a real radio. */
  simulated: boolean;
  deviceName: string | null;
}

export interface OverboardBleLink extends OverboardLink {
  connect(): Promise<void>;
  disconnect(): void;
  getSnapshot(): BleLinkSnapshot;
  subscribe(listener: () => void): () => void;
}

const SCAN_DELAY_MS = 900;
const RSSI_PERIOD_MS = 1000;
const LOG_EVERY_N_FRAMES = 10;

export function createOverboardBleStub(): OverboardBleLink {
  const stats = emptyStats();
  const listeners = new Set<() => void>();
  let snapshot: BleLinkSnapshot = { state: 'idle', rssi: null, simulated: true, deviceName: null };
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let rssiTimer: ReturnType<typeof setInterval> | null = null;
  /** Settles the in-flight scan wait so `connect()` never hangs. */
  let finishScan: (() => void) | null = null;

  const set = (patch: Partial<BleLinkSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((l) => l());
  };

  const clearTimers = () => {
    if (scanTimer) clearTimeout(scanTimer);
    if (rssiTimer) clearInterval(rssiTimer);
    scanTimer = null;
    rssiTimer = null;
    finishScan?.();
    finishScan = null;
  };

  const disconnect = () => {
    clearTimers();
    set({ state: 'idle', rssi: null, deviceName: null });
  };

  return {
    mode: 'ble',
    async connect() {
      if (snapshot.state === 'scanning' || snapshot.state === 'connected') return;
      set({ state: 'scanning' });
      await new Promise<void>((resolve) => {
        finishScan = resolve;
        scanTimer = setTimeout(resolve, SCAN_DELAY_MS);
      });
      finishScan = null;
      // Re-read: disconnect() may have run during the scan delay.
      if ((snapshot.state as BleLinkState) !== 'scanning') return;
      set({ state: 'connected', deviceName: 'Overboard (stub)', rssi: -58 });
      // Random walk around -60 dBm so the signal bars visibly live.
      rssiTimer = setInterval(() => {
        const prev = snapshot.rssi ?? -60;
        const next = Math.round(Math.max(-95, Math.min(-35, prev + (Math.random() - 0.5) * 8)));
        set({ rssi: next });
      }, RSSI_PERIOD_MS);
    },
    disconnect,
    send(drive) {
      if (snapshot.state !== 'connected') return;
      stats.sent += 1;
      if (stats.sent % LOG_EVERY_N_FRAMES === 1) {
        console.debug('[overboard/ble-stub] would write', drive, `(#${stats.sent})`);
      }
    },
    getStats: () => ({ ...stats }),
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disconnect();
      listeners.clear();
    },
  };
}

/** RSSI (dBm) → 0..3 bars for `LinkQualityBars`. */
export function rssiToLevel(rssi: number | null): 0 | 1 | 2 | 3 {
  if (rssi === null) return 0;
  if (rssi >= -60) return 3;
  if (rssi >= -75) return 2;
  return 1;
}
