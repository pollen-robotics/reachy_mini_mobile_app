/**
 * Tests for the central-listing field extractors.
 *
 * Central's payload schema has loosened over time (id / peerId /
 * peer_id all show up across versions of the relay), so the
 * extractors normalise into a single canonical view. These tests
 * pin that contract.
 */
import { describe, expect, it } from 'vitest';

import {
  extractRobotHardwareId,
  extractRobotId,
  extractRobotName,
  extractRobotTransport,
  type CentralRobotEntry,
} from './fetchRobotsFromCentral';

describe('extractRobotId', () => {
  it('returns null on undefined entry', () => {
    expect(extractRobotId(undefined)).toBeNull();
  });

  it('returns null when no id-shaped field is present', () => {
    expect(extractRobotId({})).toBeNull();
  });

  it('reads `id` first', () => {
    const entry: CentralRobotEntry = {
      id: 'pollen/abc',
      peerId: 'should-be-ignored',
      peer_id: 'also-ignored',
    };
    expect(extractRobotId(entry)).toBe('pollen/abc');
  });

  it('falls back to `peerId` when `id` is missing', () => {
    expect(extractRobotId({ peerId: 'peer-123' })).toBe('peer-123');
  });

  it('falls back to `peer_id` when neither `id` nor `peerId` is present', () => {
    expect(extractRobotId({ peer_id: 'snake-456' })).toBe('snake-456');
  });

  it('returns null when the chosen field is an empty string', () => {
    expect(extractRobotId({ id: '' })).toBeNull();
  });

  it('rejects non-string id fields', () => {
    // The wire is loose-typed, so guard against non-strings.
    expect(extractRobotId({ id: 42 } as unknown as CentralRobotEntry)).toBeNull();
  });
});

describe('extractRobotName', () => {
  it("returns 'Unknown robot' when entry is undefined", () => {
    expect(extractRobotName(undefined)).toBe('Unknown robot');
  });

  it('prefers meta.name when present', () => {
    expect(
      extractRobotName({
        meta: { name: 'reachy-mini-foo' },
        name: 'should-not-win',
      }),
    ).toBe('reachy-mini-foo');
  });

  it('falls back to top-level name', () => {
    expect(extractRobotName({ name: 'fallback' })).toBe('fallback');
  });

  it('falls back to the id when no name fields are present', () => {
    expect(extractRobotName({ id: 'pollen/abc' })).toBe('pollen/abc');
  });

  it("falls back to 'Unknown robot' when nothing identifies the entry", () => {
    expect(extractRobotName({})).toBe('Unknown robot');
  });
});

describe('extractRobotHardwareId', () => {
  it('returns the meta.hardware_id when valid', () => {
    expect(extractRobotHardwareId({ meta: { hardware_id: 'a1b2c3d4' } })).toBe(
      'a1b2c3d4',
    );
  });

  it('returns null when meta is absent', () => {
    expect(extractRobotHardwareId({})).toBeNull();
  });

  it('returns null when hardware_id is empty string', () => {
    expect(extractRobotHardwareId({ meta: { hardware_id: '' } })).toBeNull();
  });

  it('returns null on non-string hardware_id', () => {
    expect(
      extractRobotHardwareId({
        meta: { hardware_id: 42 } as unknown as { hardware_id: string },
      }),
    ).toBeNull();
  });

  it('returns null on undefined entry', () => {
    expect(extractRobotHardwareId(undefined)).toBeNull();
  });
});

describe('extractRobotTransport', () => {
  it("defaults to 'wifi' when meta is absent", () => {
    expect(extractRobotTransport({})).toBe('wifi');
  });

  it("defaults to 'wifi' when entry is undefined", () => {
    expect(extractRobotTransport(undefined)).toBe('wifi');
  });

  it('returns the advertised transport when set', () => {
    expect(extractRobotTransport({ meta: { transport: 'usb' } })).toBe('usb');
    expect(extractRobotTransport({ meta: { transport: 'wifi' } })).toBe('wifi');
  });

  it('passes future / unknown transport values through verbatim', () => {
    // We deliberately leave the type as a free-form string so a
    // future daemon advertising `ethernet` / `sim` / `mockup`
    // doesn't need a client release.
    expect(
      extractRobotTransport({ meta: { transport: 'ethernet' } }),
    ).toBe('ethernet');
  });

  it("falls back to 'wifi' on empty transport string", () => {
    expect(extractRobotTransport({ meta: { transport: '' } })).toBe('wifi');
  });
});
