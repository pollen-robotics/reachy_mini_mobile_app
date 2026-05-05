/**
 * BLE advertisement parser (matches the daemon's `encode_advert_payload`
 * in `bluetooth_service.py`).
 *
 * Wire layout, single ManufacturerData entry under
 * `POLLEN_MANUFACTURER_ID = 0xFFFF`:
 *
 *     byte 0      : flag  (0x00 = LAN, 0x01 = hotspot AP)
 *     bytes 1-4   : IPv4 (network byte order)
 *     bytes 5-11  : hardware_id prefix (first 7 bytes = 14 hex chars)
 *
 * The format is **wire-compatible** with the legacy IPv4-list advert:
 * any old client that parses pairs of `[flag][IPv4]` still reads the
 * first IP correctly. Trailing bytes (the hwid prefix) may be
 * mis-decoded by such clients as a "second IP", which is harmless
 * (no consumer in this codebase reads IPs from the advert) but worth
 * documenting for anyone porting the wire format.
 *
 * Parsing rules (this module):
 *   - `payload.length < 5`  -> garbage, return all-null
 *   - bytes 0..4 always parsed as `[flag][IPv4]`
 *   - bytes 5..11 parsed as hwid prefix only when `payload.length >= 12`
 *
 * Returning `null` for hwid means "this advert does not carry a stable
 * id"; consumers MUST NOT invent one (e.g. fall back on the BLE
 * address) since that creates a different id space and confuses the
 * cross-source dedup the picker relies on.
 */
export const POLLEN_MANUFACTURER_ID = 0xffff;

export const ADVERT_FLAG_LAN = 0x00;
export const ADVERT_FLAG_HOTSPOT = 0x01;

const IP_OFFSET = 1;
const HARDWARE_ID_OFFSET = 5;
const HARDWARE_ID_PREFIX_LEN = 7; // bytes (= 14 hex chars)
const FULL_PAYLOAD_LEN = HARDWARE_ID_OFFSET + HARDWARE_ID_PREFIX_LEN; // 12

export type RobotAdvertNetworkMode = 'lan' | 'hotspot';

export interface RobotAdvert {
  /** Network mode encoded in the leading flag byte. */
  networkMode: RobotAdvertNetworkMode | null;
  /** First IPv4 published by the daemon (wlan0 if available). Dotted
   * quad, or null when the advert carries no IP slot. */
  ip: string | null;
  /** First 14 hex chars of the daemon's `hardware_id`. Same prefix the
   * picker UI displays as `id:<5 chars>`. Null when not advertised. */
  hardwareId: string | null;
}

/**
 * Decode the manufacturer-data slot of a BLE advertisement into the
 * structured fields the picker needs. Always returns an object;
 * missing fields are `null` rather than thrown.
 *
 * @param manufacturerData - the plugin-provided
 *   `Record<manufacturer_id, byte_array>` mapping. Only the slot
 *   under `POLLEN_MANUFACTURER_ID` is consumed; everything else is
 *   ignored.
 */
export function parseRobotAdvert(
  manufacturerData: Record<number, number[]> | undefined | null,
): RobotAdvert {
  const empty: RobotAdvert = { networkMode: null, ip: null, hardwareId: null };
  if (!manufacturerData) return empty;
  const bytes = manufacturerData[POLLEN_MANUFACTURER_ID];
  if (!Array.isArray(bytes) || bytes.length < HARDWARE_ID_OFFSET) return empty;

  const flag = bytes[0];
  const networkMode: RobotAdvertNetworkMode | null =
    flag === ADVERT_FLAG_LAN
      ? 'lan'
      : flag === ADVERT_FLAG_HOTSPOT
        ? 'hotspot'
        : null;

  const ipBytes = bytes.slice(IP_OFFSET, IP_OFFSET + 4);
  const ip =
    ipBytes.length === 4
      ? ipBytes.map((b) => (b & 0xff).toString(10)).join('.')
      : null;

  let hardwareId: string | null = null;
  if (bytes.length >= FULL_PAYLOAD_LEN) {
    const hwidBytes = bytes.slice(HARDWARE_ID_OFFSET, FULL_PAYLOAD_LEN);
    hardwareId = hwidBytes
      .map((b) => (b & 0xff).toString(16).padStart(2, '0'))
      .join('');
  }

  return { networkMode, ip, hardwareId };
}

/**
 * Convenience: extract just the hardware id when callers don't care
 * about the IP / network mode. Equivalent to
 * `parseRobotAdvert(...).hardwareId`.
 */
export function parseAdvertHardwareId(
  manufacturerData: Record<number, number[]> | undefined | null,
): string | null {
  return parseRobotAdvert(manufacturerData).hardwareId;
}
