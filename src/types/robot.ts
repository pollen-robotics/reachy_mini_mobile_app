/**
 * Shared types for the BLE-driven Wi-Fi setup flow.
 *
 * Earlier revisions of the app exposed an mDNS / Rust-side
 * `DiscoveredRobot` shape too. That path is now handled directly
 * by `useBleSession` (BLE plugin) and `useRemoteRobots` (HF central),
 * so this file only carries the Wi-Fi state types still consumed by
 * `useWifiSetup`, `humanizeWifiError`, and `FailedView`.
 */

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

/**
 * Result of the daemon's `WIFI_PROBE` BLE command (see `_wifi_probe`
 * in `bluetooth_service.py`). One tag per layer of the connectivity
 * stack so the UI can pinpoint which hop failed.
 *
 * Each value is a small free-form string; we don't enumerate the
 * possible values at the type level so a future daemon can add new
 * statuses (`captive-portal`, `slow`, ...) without a client release.
 * The reference daemon emits:
 *
 *   * `wlan`     - `ok` | `down` | `error`
 *   * `gateway`  - `ok` | `unreachable`
 *   * `dns`      - `ok` | `fail`
 *   * `internet` - `ok` | `fail`
 *   * `daemon`   - `ok` | `fail`
 *
 * Probes that exceeded the daemon's total budget (typically a stuck
 * DNS or a hung subprocess) report `timeout`. Any unmodelled value
 * is rendered as-is by the UI ("status: <value>").
 */
export interface WifiProbeResult {
  wlan: string;
  gateway: string;
  dns: string;
  internet: string;
  daemon: string;
}
