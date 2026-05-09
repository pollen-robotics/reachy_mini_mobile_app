/**
 * Plain-text NETWORK_STATUS payload parser for the Reachy daemon's
 * BLE characteristic.
 *
 * Wire format (source: `bluetooth_service.py::get_network_status`):
 *
 *   "{MODE} [iface] ip [ ; [iface] ip ]*"
 *     e.g. "CONNECTED [wlan0] 192.168.1.19"
 *          "CONNECTED [wlan0] 192.168.1.19 ; [eth0] 10.0.0.5"
 *   "OFFLINE"   - no interfaces up
 *   "ERROR"     - daemon failed to enumerate
 *
 * MODE ∈ {CONNECTED, HOTSPOT, OFFLINE} (uppercase on the wire,
 * lowercased in the returned shape so the rest of the app reads
 * one canonical case).
 *
 * Lives in its own module on purpose: the `useBleSession` hook
 * pulls in `@mnlphlp/plugin-blec` (Tauri-only) at import time, and
 * keeping the parser free of that dep lets us unit-test it under
 * plain Node.
 */

export interface NetworkStatus {
  hostname: string;
  ip: string | null;
  port: number;
  /** Free-form mode string as advertised by the daemon (`connected`,
   * `hotspot`, `offline`, ...). We don't enumerate it here because the
   * daemon may add new modes in future firmwares; consumers match
   * against known values and fall back to "unknown". */
  mode: string;
}

/**
 * Parse the daemon's plain-text NETWORK_STATUS payload.
 *
 * Rules:
 *   - Empty / "ERROR" payloads → null (caller should retry).
 *   - "OFFLINE" (no interfaces) → mode='offline', ip=null.
 *   - "HOTSPOT [wlan0] 10.42.0.1" → mode='hotspot', ip=10.42.0.1.
 *     The IP is technically reachable (if you're on the robot's AP)
 *     but the HTTP probe will decide that.
 *   - "CONNECTED [wlan0] 192.168.1.19 ; [eth0] 10.0.0.5" →
 *     mode='connected', ip picked from wlan0 > eth0 > first-listed.
 */
export function parseNetworkStatus(raw: string): NetworkStatus | null {
  if (!raw || raw === 'ERROR') return null;

  // Head word is the mode, rest is interface list. Split on first whitespace.
  const firstSpace = raw.indexOf(' ');
  const head = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : raw.slice(firstSpace + 1).trim();
  const mode = head.toLowerCase();

  if (rest.length === 0) {
    // Just "OFFLINE" or any other bare mode - no IP yet.
    return { hostname: '', ip: null, port: 8000, mode };
  }

  // Interface entries are separated by " ; "; each entry looks like
  // "[wlan0] 192.168.1.19". We tolerate missing spaces / extra
  // whitespace since the format is hand-built on the daemon side.
  const entries = rest
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const interfaces: Array<{ iface: string; ip: string }> = [];
  for (const entry of entries) {
    const match = entry.match(/^\[([^\]]+)\]\s*(\S+)/);
    if (match && match[1] && match[2]) {
      interfaces.push({ iface: match[1], ip: match[2] });
    }
  }

  // Prefer wlan0, then eth0, then whatever the daemon listed first.
  const preferred =
    interfaces.find((i) => i.iface === 'wlan0') ??
    interfaces.find((i) => i.iface === 'eth0') ??
    interfaces[0] ??
    null;

  return {
    hostname: '',
    ip: preferred?.ip ?? null,
    port: 8000,
    mode,
  };
}
