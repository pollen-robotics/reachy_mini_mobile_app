/**
 * Shared types describing a Reachy Mini as seen from the mobile client.
 *
 * Everything in this file is transport-agnostic: `DiscoveredRobot` is what
 * the UI consumes, whether it came from mDNS, a manual IP input, or a
 * future BLE path.
 */

/** Robot network mode as reported by the daemon's BLE status char. */
export type RobotNetworkMode = 'connected' | 'hotspot' | 'offline' | 'unknown';

/**
 * A robot resolved by the Rust discovery task (BLE scan + GATT read) or
 * added manually by the user.
 *
 * Matches the Rust payload emitted via `robot:discovered` events (see
 * `src-tauri/src/discovery.rs::DiscoveredRobot`). `ip` is `null` when
 * the robot is in OFFLINE mode - the BLE link is still usable but we
 * cannot reach the daemon over HTTP yet.
 */
export interface DiscoveredRobot {
  /** Advertised local name, e.g. `ReachyMini`, or a user-typed label. */
  name: string;
  /** Informational hostname guess. Empty for BLE-only discovery. */
  hostname: string;
  /** Primary IPv4 address. Null when the robot is offline. */
  ip: string | null;
  /** Daemon HTTP port, defaults to 8000 when unknown. */
  port: number;
  /** Robot network mode decoded from the BLE NETWORK_STATUS char. */
  mode: RobotNetworkMode;
  /** Stable identifier for this entry (BLE peripheral id or manual host). */
  address: string;
  /** Unix ms timestamp of the last successful BLE read. */
  lastSeenMs: number;
  /** How this robot ended up in the cache. */
  source: 'ble' | 'manual';
}

/**
 * High-level connection state machine for the current robot.
 *
 * We only promote to `connected` once the daemon answered
 * `/api/daemon/status` successfully over HTTP.
 */
export type ConnectionState =
  | 'idle'
  | 'scanning'
  | 'daemon-probing'
  | 'connected'
  | 'error';

/**
 * WiFi state as returned by the daemon's `WIFI_STATUS` BLE command
 * (see `_wifi_status` in `bluetooth_service.py`).
 *
 * * `mode` follows the daemon's `WifiMode` enum: `wlan` | `hotspot` |
 *   `disconnected` | `busy`. May be null if the daemon was unreachable
 *   from the BT service side.
 * * `connected` is the SSID of the currently active network (only when
 *   `mode === 'wlan'`), or null.
 * * `known` is the list of SSIDs already saved in NetworkManager (Hotspot
 *   is filtered out by the daemon).
 * * `error` surfaces the last `nmcli` failure (bad password, SSID out of
 *   range, etc.) - clears after a successful `connect`.
 */
export interface BleWifiStatus {
  mode: string | null;
  connected: string | null;
  known: string[];
  error: string | null;
}
