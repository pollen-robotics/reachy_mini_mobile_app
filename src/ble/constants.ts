/**
 * BLE UUIDs exposed by the Reachy Mini daemon's `bluetooth_service.py`.
 *
 * Source of truth:
 * https://github.com/pollen-robotics/reachy_mini/blob/main/src/reachy_mini/daemon/bluetooth_service.py
 *
 * Mirrored in the desktop app (`reachy_mini_desktop_app/src/hooks/bluetooth/useBluetooth.ts`).
 */

/** Advertised service used for filtering the BLE scan. */
export const STATUS_SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef3';

/** Network status characteristic (read-only, no auth). */
export const NETWORK_STATUS_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef4';

/** Command service hosting the read/write command channel. */
export const CMD_SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';

/** Client-writes command characteristic. */
export const COMMAND_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef1';

/** Client-reads response characteristic. Populated synchronously by the
 * daemon before the write-ack returns, so a small buffer delay suffices. */
export const RESPONSE_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef2';

/** Substring match on advertised name used to filter non-Reachy devices
 * returned by the plugin's scan callback. We normalise by stripping
 * dashes and lowercasing before comparing. */
export const REACHY_NAME_SUBSTRING = 'reachymini';

/** How long the plugin keeps scanning on a single `startScan()` call. */
export const SCAN_TIMEOUT_MS = 15_000;

/** Wait between a write-with-response ack and the follow-up read.
 * Matches the desktop app (500 ms) - the daemon populates the response
 * synchronously but CoreBluetooth batches characteristic-changed
 * notifications in 20-100 ms windows. */
export const RESPONSE_READ_DELAY_MS = 500;

/**
 * Pollen / Reachy Mini "manufacturer id" used in the BLE advertisement
 * ManufacturerData section. ``0xFFFF`` is the Bluetooth SIG-reserved id
 * for development/testing; the daemon publishes its install_id under
 * this key (see ``bluetooth_service.encode_advert_manufacturer_data``).
 */
export const POLLEN_MANUFACTURER_ID = 0xffff;

/** Versioned ManufacturerData layout we parse from the advertisement. */
export const ADVERT_FORMAT_VERSION = 0x02;
/** TLV tag for the install_id prefix (8 bytes). */
export const ADVERT_TLV_INSTALL_ID = 0x01;
/** Number of raw bytes the daemon publishes for the install_id prefix. */
export const ADVERT_INSTALL_ID_PREFIX_BYTES = 8;
/**
 * TLV tag for the central peerId prefix (8 bytes). Optional - only
 * present when the daemon's central relay is online. Used to dedupe a
 * BLE row against the same physical robot's central listing while the
 * central server does not yet propagate ``meta.install_id``.
 */
export const ADVERT_TLV_CENTRAL_PEER_ID = 0x02;
/** Number of raw bytes the daemon publishes for the central peerId prefix. */
export const ADVERT_CENTRAL_PEER_ID_PREFIX_BYTES = 8;

/**
 * TLV tag for the daemon's local network mode (1-byte enum).
 *
 * Authoritative signal for "is Wi-Fi setup done?". Computed by the
 * daemon directly off ``ip -4 addr show`` (no central / Internet /
 * token dependency), so it doesn't flicker when the relay loses its
 * registration to HF central. Values defined as
 * ``ADVERT_NETWORK_MODE_*`` below. Absent on legacy daemons.
 */
export const ADVERT_TLV_NETWORK_MODE = 0x03;
export const ADVERT_NETWORK_MODE_BYTES = 1;
/** No usable IP on any interface. */
export const ADVERT_NETWORK_MODE_OFFLINE = 0x00;
/** wlan0 holds the daemon's hotspot fallback (10.42.0.1). */
export const ADVERT_NETWORK_MODE_HOTSPOT = 0x01;
/** A real LAN/WAN IP is present on at least one interface. */
export const ADVERT_NETWORK_MODE_CONNECTED = 0x02;
