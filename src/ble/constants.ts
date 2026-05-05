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

// Note: the daemon also exposes a HARDWARE_ID GATT characteristic
// (`12345678-1234-5678-1234-56789abcdef7`) but the mobile app does
// not need it: the same value is published in the BLE advertisement
// manufacturer data (TLV v0x02, tag 0x01) and is parsed at scan
// time without GATT-connecting. Keep this comment as a pointer for
// other clients that might still want the GATT path.

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
