/**
 * Parser for the Reachy Mini BLE advertisement ``ManufacturerData``.
 *
 * The daemon publishes a versioned TLV payload under the Pollen
 * manufacturer id (``0xFFFF``) - see
 * ``reachy_mini/daemon/app/services/bluetooth/bluetooth_service.py``
 * (``encode_advert_manufacturer_data``) for the source of truth.
 *
 * We decode it into a small POJO that the BLE session store attaches
 * to every discovered ``ReachyBleDevice``. The mobile robot registry
 * then uses ``installIdPrefix`` to dedupe BLE rows against
 * localhost-loopback / central rows for the same physical robot.
 */

import {
  ADVERT_CENTRAL_PEER_ID_PREFIX_BYTES,
  ADVERT_FORMAT_VERSION,
  ADVERT_INSTALL_ID_PREFIX_BYTES,
  ADVERT_NETWORK_MODE_BYTES,
  ADVERT_NETWORK_MODE_CONNECTED,
  ADVERT_NETWORK_MODE_HOTSPOT,
  ADVERT_NETWORK_MODE_OFFLINE,
  ADVERT_TLV_CENTRAL_PEER_ID,
  ADVERT_TLV_INSTALL_ID,
  ADVERT_TLV_NETWORK_MODE,
  POLLEN_MANUFACTURER_ID,
} from './constants';

/**
 * Daemon-reported local network mode, decoded from BLE TLV 0x03.
 *
 *   - ``'connected'`` - the daemon has a real LAN/WAN IP (Wi-Fi
 *     joined OR USB-tether interface up).
 *   - ``'hotspot'``   - wlan0 is on 10.42.0.1; the daemon is
 *     broadcasting its own AP because no known Wi-Fi was reached.
 *   - ``'offline'``   - no IPv4 on any interface.
 *   - ``null``        - the BLE advert didn't carry the TLV (legacy
 *     daemon, or sub-second-old daemon that hasn't refreshed yet).
 */
export type NetworkMode = 'connected' | 'hotspot' | 'offline';

export interface ParsedAdvertManufacturerData {
  /**
   * 16-character lowercase hex string (= 8 raw bytes) of the daemon's
   * install_id prefix, or ``null`` when the advert carries no
   * install_id TLV (older daemon, malformed payload, ...).
   */
  installIdPrefix: string | null;
  /**
   * 16-character lowercase hex string (= 8 raw bytes) of the
   * relay-assigned central peerId prefix, or ``null`` when the advert
   * doesn't carry the central peerId TLV (relay offline, no token,
   * older daemon). Volatile - rotates on every relay reconnect on the
   * daemon side.
   */
  centralPeerIdPrefix: string | null;
  /**
   * Authoritative local network mode, decoded from TLV 0x03. Prefer
   * this over inferring "Wi-Fi setup done?" from the presence of
   * ``centralPeerIdPrefix``: that signal flickers when central
   * registration breaks even though the robot's local Wi-Fi works.
   * ``null`` for legacy daemons that don't publish 0x03.
   */
  networkMode: NetworkMode | null;
}

/** Convert a byte array into its lowercase hex representation. */
function bytesToHex(bytes: number[]): string {
  let out = '';
  for (const b of bytes) {
    out += (b & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Parse the ``manufacturerData`` map exposed by ``@mnlphlp/plugin-blec``
 * for a discovered Reachy Mini.
 *
 * Always returns a populated object (with ``installIdPrefix=null``
 * when the payload is missing or unparseable) so callers can blindly
 * spread it onto a ``ReachyBleDevice`` without null-juggling.
 */
export function parseAdvertManufacturerData(
  manufacturerData: Record<number, number[]> | undefined | null,
): ParsedAdvertManufacturerData {
  const empty: ParsedAdvertManufacturerData = {
    installIdPrefix: null,
    centralPeerIdPrefix: null,
    networkMode: null,
  };
  if (!manufacturerData) return empty;

  const payload = manufacturerData[POLLEN_MANUFACTURER_ID];
  if (!Array.isArray(payload) || payload.length < 1) return empty;

  // Byte 0: format version. Anything else is either an older daemon
  // (which used to publish an IPv4 list under the same key, no
  // install_id) or a future format we don't grok yet.
  if (payload[0] !== ADVERT_FORMAT_VERSION) return empty;

  let cursor = 1;
  let installIdPrefix: string | null = null;
  let centralPeerIdPrefix: string | null = null;
  let networkMode: NetworkMode | null = null;
  while (cursor + 1 < payload.length) {
    const tag = payload[cursor];
    const len = payload[cursor + 1];
    const valueStart = cursor + 2;
    const valueEnd = valueStart + len;
    if (valueEnd > payload.length) break; // truncated TLV; stop here

    if (
      tag === ADVERT_TLV_INSTALL_ID &&
      len === ADVERT_INSTALL_ID_PREFIX_BYTES
    ) {
      installIdPrefix = bytesToHex(payload.slice(valueStart, valueEnd));
    } else if (
      tag === ADVERT_TLV_CENTRAL_PEER_ID &&
      len === ADVERT_CENTRAL_PEER_ID_PREFIX_BYTES
    ) {
      centralPeerIdPrefix = bytesToHex(payload.slice(valueStart, valueEnd));
    } else if (
      tag === ADVERT_TLV_NETWORK_MODE &&
      len === ADVERT_NETWORK_MODE_BYTES
    ) {
      const byte = payload[valueStart] & 0xff;
      networkMode =
        byte === ADVERT_NETWORK_MODE_CONNECTED
          ? 'connected'
          : byte === ADVERT_NETWORK_MODE_HOTSPOT
            ? 'hotspot'
            : byte === ADVERT_NETWORK_MODE_OFFLINE
              ? 'offline'
              : null; // unknown enum value: leave as null
    }
    // Unknown tags are silently ignored so the format can grow.

    cursor = valueEnd;
  }

  return { installIdPrefix, centralPeerIdPrefix, networkMode };
}
