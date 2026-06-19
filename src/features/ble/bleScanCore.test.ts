/**
 * Tests for the pure BLE scan core - the deterministic heart of device
 * discovery. No plugin, no timers, no wall clock: the registry takes the
 * current time as a parameter, so staleness is verified by arithmetic
 * rather than fake timers.
 */
import { describe, expect, it } from 'vitest';

import {
  type BleDevice,
  createScanRegistry,
  looksLikeReachy,
  normalizeDevice,
  parseScanMessage,
  reachyBySignal,
} from './bleScanCore';

const dev = (over: Partial<BleDevice> = {}): BleDevice => ({
  address: 'AA:BB',
  name: 'Reachy Mini',
  services: [],
  rssi: -50,
  raw: {},
  ...over,
});

describe('normalizeDevice', () => {
  it('reads the address from address | id | uuid', () => {
    expect(normalizeDevice({ address: 'A' }).address).toBe('A');
    expect(normalizeDevice({ id: 'B' }).address).toBe('B');
    expect(normalizeDevice({ uuid: 'C' }).address).toBe('C');
  });

  it('reads the name from name | localName and defaults to null', () => {
    expect(normalizeDevice({ name: 'Reachy' }).name).toBe('Reachy');
    expect(normalizeDevice({ localName: 'Reachy' }).name).toBe('Reachy');
    expect(normalizeDevice({ address: 'A' }).name).toBeNull();
  });

  it('lower-cases services from any of the known keys', () => {
    expect(normalizeDevice({ services: ['ABCDEF0'] }).services).toEqual(['abcdef0']);
    expect(normalizeDevice({ serviceUuids: ['CDEF3'] }).services).toEqual(['cdef3']);
    expect(normalizeDevice({ advertisedServices: ['Xy'] }).services).toEqual(['xy']);
  });

  it('keeps rssi only when numeric', () => {
    expect(normalizeDevice({ rssi: -42 }).rssi).toBe(-42);
    expect(normalizeDevice({ rssi: 'nope' }).rssi).toBeUndefined();
    expect(normalizeDevice({}).rssi).toBeUndefined();
  });

  it('preserves the raw object for diagnostics', () => {
    const raw = { id: 'A', extra: 1 };
    expect(normalizeDevice(raw).raw).toBe(raw);
  });
});

describe('parseScanMessage', () => {
  it('accepts an array of devices', () => {
    const out = parseScanMessage([{ id: 'A' }, { id: 'B' }]);
    expect(out.map((d) => d.address)).toEqual(['A', 'B']);
  });

  it('accepts a single device object', () => {
    expect(parseScanMessage({ id: 'A' }).map((d) => d.address)).toEqual(['A']);
  });

  it('unwraps a { result: device } envelope', () => {
    expect(parseScanMessage({ result: { id: 'A' } }).map((d) => d.address)).toEqual(['A']);
  });

  it('treats null / undefined / empty as no devices', () => {
    expect(parseScanMessage(null)).toEqual([]);
    expect(parseScanMessage(undefined)).toEqual([]);
    expect(parseScanMessage([])).toEqual([]);
  });

  it('drops entries without an address', () => {
    const out = parseScanMessage([{ id: 'A' }, { name: 'no-addr' }, null, 'junk']);
    expect(out.map((d) => d.address)).toEqual(['A']);
  });
});

describe('looksLikeReachy', () => {
  it('matches by name, case-insensitively', () => {
    expect(looksLikeReachy(dev({ name: 'reachy mini #1' }))).toBe(true);
    expect(looksLikeReachy(dev({ name: 'My REACHY' }))).toBe(true);
  });

  it('matches by advertised command/status service when the name is absent', () => {
    expect(looksLikeReachy(dev({ name: null, services: ['12345678-cdef0-...'] }))).toBe(true);
    expect(looksLikeReachy(dev({ name: null, services: ['...cdef3...'] }))).toBe(true);
  });

  it('rejects unrelated devices', () => {
    expect(looksLikeReachy(dev({ name: 'AirPods', services: ['1800'] }))).toBe(false);
    expect(looksLikeReachy(dev({ name: null, services: [] }))).toBe(false);
  });
});

describe('reachyBySignal', () => {
  it('keeps only Reachy devices', () => {
    const out = reachyBySignal([
      dev({ address: 'A', name: 'Reachy A' }),
      dev({ address: 'B', name: 'Speaker' }),
    ]);
    expect(out.map((d) => d.address)).toEqual(['A']);
  });

  it('orders strongest signal first (rssi closest to 0)', () => {
    const out = reachyBySignal([
      dev({ address: 'far', rssi: -80 }),
      dev({ address: 'near', rssi: -40 }),
      dev({ address: 'mid', rssi: -60 }),
    ]);
    expect(out.map((d) => d.address)).toEqual(['near', 'mid', 'far']);
  });

  it('sinks devices without rssi to the bottom', () => {
    const out = reachyBySignal([
      dev({ address: 'unknown', rssi: undefined }),
      dev({ address: 'strong', rssi: -30 }),
    ]);
    expect(out.map((d) => d.address)).toEqual(['strong', 'unknown']);
  });
});

describe('createScanRegistry', () => {
  it('dedupes by address and refreshes the device value', () => {
    const reg = createScanRegistry(1000);
    reg.ingest([dev({ address: 'A', rssi: -70 })], 0);
    reg.ingest([dev({ address: 'A', rssi: -40 })], 100);
    const live = reg.live(100);
    expect(live).toHaveLength(1);
    expect(live[0].rssi).toBe(-40);
  });

  it('preserves insertion order across refreshes', () => {
    const reg = createScanRegistry(1000);
    reg.ingest([dev({ address: 'A' }), dev({ address: 'B' })], 0);
    reg.ingest([dev({ address: 'A', rssi: -10 })], 50);
    expect(reg.live(50).map((d) => d.address)).toEqual(['A', 'B']);
  });

  it('prunes entries not seen within staleAfterMs', () => {
    const reg = createScanRegistry(1000);
    reg.ingest([dev({ address: 'old' })], 0);
    reg.ingest([dev({ address: 'fresh' })], 800);
    // at t=1500: old last seen at 0 (age 1500 > 1000) -> pruned; fresh age 700.
    expect(reg.live(1500).map((d) => d.address)).toEqual(['fresh']);
  });

  it('keeps an entry exactly at the staleness boundary', () => {
    const reg = createScanRegistry(1000);
    reg.ingest([dev({ address: 'A' })], 0);
    // cutoff = now - staleAfterMs = 1000 - 1000 = 0; ts(0) < 0 is false -> kept.
    expect(reg.live(1000).map((d) => d.address)).toEqual(['A']);
    // one tick later it falls off.
    expect(reg.live(1001)).toEqual([]);
  });

  it('re-seeing a device keeps it alive past the original window', () => {
    const reg = createScanRegistry(1000);
    reg.ingest([dev({ address: 'A' })], 0);
    reg.ingest([dev({ address: 'A' })], 900);
    expect(reg.live(1500).map((d) => d.address)).toEqual(['A']);
  });
});
