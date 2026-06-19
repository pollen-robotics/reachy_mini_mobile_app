/**
 * BLE scan core - the pure, transport-free heart of device discovery.
 *
 * Everything here is deterministic and side-effect free: no plugin calls,
 * no wall-clock reads. The wall clock is INJECTED (`now`) so the staleness
 * logic can be unit-tested without fake timers, and the plugin-message
 * shape tolerance lives in one place instead of being copy-pasted across
 * `scanDevices` / `startContinuousScan`.
 *
 * See `docs/BLE_SCAN_ARCHITECTURE.md` for the rationale and prior art
 * (Home Assistant `habluetooth`, bleak, fencing tokens, injectable clocks).
 *
 * The transport loop + plugin wiring stays in `bleWifi.ts`, which composes
 * these primitives.
 */

// The plugin's device object shape varies by version; keep it permissive and
// surface the raw object so the UI can show exactly what came back.
export interface BleDevice {
  address: string;
  name?: string | null;
  services?: string[];
  rssi?: number;
  raw: unknown; // the untouched plugin object, for diagnostics
}

const REACHY_NAME_RE = /reachy/i;

/**
 * Normalize one raw plugin device object into a {@link BleDevice}.
 *
 * Different plugin versions key the address as `address | id | uuid` and the
 * name as `name | localName`; services may arrive under several keys. We
 * lower-case service UUIDs so matching is case-insensitive, and only keep a
 * numeric RSSI (some Android stacks omit it).
 */
export function normalizeDevice(d: Record<string, unknown>): BleDevice {
  const address = String(d.address ?? d.id ?? d.uuid ?? '');
  const nameRaw = d.name ?? d.localName;
  const name = typeof nameRaw === 'string' ? nameRaw : null;
  const rawServices = (d.services ?? d.serviceUuids ?? d.advertisedServices ?? []) as unknown[];
  const services: string[] = rawServices.map((s) => String(s).toLowerCase());
  const rssi = typeof d.rssi === 'number' ? d.rssi : undefined;
  return { address, name, services, rssi, raw: d };
}

/**
 * Normalize a raw scan-channel message into a list of {@link BleDevice}.
 *
 * The channel may deliver an array of devices, a single device, or a
 * `{ result: device }` wrapper depending on platform/version - accept all,
 * and treat null/undefined/empty as "no devices". Entries without an
 * address are dropped (they can't be deduped or connected to).
 */
export function parseScanMessage(msg: unknown): BleDevice[] {
  const list: unknown[] = Array.isArray(msg)
    ? msg
    : msg && typeof msg === 'object' && 'result' in msg
      ? [(msg as { result: unknown }).result]
      : msg
        ? [msg]
        : [];
  const out: BleDevice[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const d = normalizeDevice(raw as Record<string, unknown>);
    if (d.address) out.push(d);
  }
  return out;
}

/** True if a device looks like a Reachy Mini (by name OR advertised service). */
export function looksLikeReachy(d: BleDevice): boolean {
  if (d.name && REACHY_NAME_RE.test(d.name)) return true;
  // Match our command/status service UUIDs even when the name is absent
  // (common on Android: name lives in the scan response, often null here).
  return d.services?.some((s) => s.includes('cdef0') || s.includes('cdef3')) ?? false;
}

/**
 * Keep only Reachy Minis and order them strongest-signal-first.
 *
 * RSSI is negative dBm (closer to 0 = stronger / nearer), so we sort
 * descending. Devices without an RSSI sink to the bottom rather than
 * jumping to the top of the list.
 */
export function reachyBySignal(devices: BleDevice[]): BleDevice[] {
  const rssiOf = (d: BleDevice): number => (typeof d.rssi === 'number' ? d.rssi : -Infinity);
  return devices.filter(looksLikeReachy).sort((a, b) => rssiOf(b) - rssiOf(a));
}

/**
 * A live, deduped device registry with last-seen staleness pruning.
 *
 * `ingest` records each device against an INJECTED timestamp (deduped by
 * address). `live` prunes anything not seen within `staleAfterMs` and
 * returns the survivors in insertion order. The clock is a parameter, not
 * `Date.now()`, so pruning is fully deterministic in tests.
 */
export interface ScanRegistry {
  /** Record/refresh devices as seen at `now` (ms epoch). */
  ingest: (devices: BleDevice[], now: number) => void;
  /** Prune entries older than `staleAfterMs` and return the live list. */
  live: (now: number) => BleDevice[];
}

export function createScanRegistry(staleAfterMs: number): ScanRegistry {
  // Map preserves insertion order; re-`set` of an existing key keeps the
  // original position while refreshing the value + timestamp.
  const seen = new Map<string, { device: BleDevice; ts: number }>();

  return {
    ingest(devices, now) {
      for (const d of devices) {
        if (d.address) seen.set(d.address, { device: d, ts: now });
      }
    },
    live(now) {
      const cutoff = now - staleAfterMs;
      for (const [addr, e] of seen) {
        if (e.ts < cutoff) seen.delete(addr);
      }
      return [...seen.values()].map((e) => e.device);
    },
  };
}
