/**
 * Wire-format parser tests for the BLE advertisement payload.
 *
 * The byte layout is documented in `parseAdvertPayload.ts`:
 *
 *   byte 0      : flag    (0x00 LAN | 0x01 hotspot)
 *   bytes 1-4   : IPv4    (network byte order)
 *   bytes 5-11  : hwid prefix (7 bytes -> 14 hex chars)
 *
 * These tests exercise both happy paths AND degraded inputs the
 * picker may see in the wild (bytes truncated by an old daemon,
 * empty manufacturer slot, missing manufacturer key, …).
 */
import { describe, expect, it } from 'vitest';

import {
  ADVERT_FLAG_HOTSPOT,
  ADVERT_FLAG_LAN,
  parseAdvertHardwareId,
  parseRobotAdvert,
  POLLEN_MANUFACTURER_ID,
} from './parseAdvertPayload';

const slot = (bytes: number[]): Record<number, number[]> => ({
  [POLLEN_MANUFACTURER_ID]: bytes,
});

describe('parseRobotAdvert', () => {
  it('returns all-null when manufacturerData is missing', () => {
    expect(parseRobotAdvert(undefined)).toEqual({
      networkMode: null,
      ip: null,
      hardwareId: null,
    });
    expect(parseRobotAdvert(null)).toEqual({
      networkMode: null,
      ip: null,
      hardwareId: null,
    });
  });

  it('returns all-null when our manufacturer key is absent', () => {
    expect(parseRobotAdvert({ 0x004c: [0, 1, 2] })).toEqual({
      networkMode: null,
      ip: null,
      hardwareId: null,
    });
  });

  it('returns all-null on payloads shorter than the IP slot', () => {
    expect(parseRobotAdvert(slot([]))).toEqual({
      networkMode: null,
      ip: null,
      hardwareId: null,
    });
    expect(parseRobotAdvert(slot([0]))).toEqual({
      networkMode: null,
      ip: null,
      hardwareId: null,
    });
    expect(parseRobotAdvert(slot([0, 192, 168]))).toEqual({
      networkMode: null,
      ip: null,
      hardwareId: null,
    });
  });

  it('parses the IPv4 + LAN flag from a 5-byte payload', () => {
    expect(
      parseRobotAdvert(slot([ADVERT_FLAG_LAN, 192, 168, 1, 19])),
    ).toEqual({
      networkMode: 'lan',
      ip: '192.168.1.19',
      hardwareId: null,
    });
  });

  it('parses the hotspot flag', () => {
    expect(
      parseRobotAdvert(slot([ADVERT_FLAG_HOTSPOT, 10, 42, 0, 1])),
    ).toEqual({
      networkMode: 'hotspot',
      ip: '10.42.0.1',
      hardwareId: null,
    });
  });

  it('falls through to networkMode=null on an unknown flag', () => {
    // Flag 0x42: not LAN, not hotspot - we don't lock the type to
    // a specific value, just signal "we don't know".
    expect(parseRobotAdvert(slot([0x42, 192, 168, 1, 1]))).toEqual({
      networkMode: null,
      ip: '192.168.1.1',
      hardwareId: null,
    });
  });

  it('extracts the hardware-id prefix when the payload is full-length', () => {
    const hwidBytes = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x01];
    const result = parseRobotAdvert(
      slot([ADVERT_FLAG_LAN, 192, 168, 1, 19, ...hwidBytes]),
    );
    expect(result.hardwareId).toBe('aabbccddeeff01');
    expect(result.hardwareId).toHaveLength(14); // 7 bytes -> 14 hex chars
  });

  it('zero-pads single-digit hex bytes', () => {
    const hwidBytes = [0x00, 0x01, 0x02, 0x0a, 0x0f, 0x10, 0x80];
    const result = parseRobotAdvert(
      slot([ADVERT_FLAG_LAN, 0, 0, 0, 0, ...hwidBytes]),
    );
    // Each byte must be exactly 2 hex chars; without padding,
    // 0x00 would render as "0" and corrupt the prefix.
    expect(result.hardwareId).toBe('0001020a0f1080');
  });

  it('keeps hardwareId null when the payload is between IP and full', () => {
    // 5 bytes (IP slot only) -> no hwid yet.
    expect(
      parseRobotAdvert(slot([ADVERT_FLAG_LAN, 1, 2, 3, 4])).hardwareId,
    ).toBeNull();
    // 11 bytes (one short of full) -> still no hwid.
    expect(
      parseRobotAdvert(
        slot([ADVERT_FLAG_LAN, 1, 2, 3, 4, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
      ).hardwareId,
    ).toBeNull();
  });

  it('masks bytes to 8 bits even when the plugin hands signed ints', () => {
    // Some platforms return Int8-flavoured arrays; -1 should still
    // decode to 255 / 0xff.
    const result = parseRobotAdvert(slot([ADVERT_FLAG_LAN, -1, 168, 1, 19]));
    expect(result.ip).toBe('255.168.1.19');
  });
});

describe('parseAdvertHardwareId', () => {
  it('is a thin convenience over parseRobotAdvert', () => {
    expect(parseAdvertHardwareId(undefined)).toBeNull();
    expect(parseAdvertHardwareId(null)).toBeNull();
    expect(parseAdvertHardwareId(slot([ADVERT_FLAG_LAN, 0, 0, 0, 0]))).toBeNull();
    const full = slot([
      ADVERT_FLAG_LAN,
      0,
      0,
      0,
      0,
      0x12,
      0x34,
      0x56,
      0x78,
      0x9a,
      0xbc,
      0xde,
    ]);
    expect(parseAdvertHardwareId(full)).toBe('123456789abcde');
  });
});
