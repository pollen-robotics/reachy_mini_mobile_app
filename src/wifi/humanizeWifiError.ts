/**
 * Mobile-side translation of daemon-relayed nmcli errors and
 * `WIFI_PROBE` results into actionable user-facing messages.
 *
 * Why mobile-side
 * ───────────────
 * The daemon's `/wifi/connect` worker catches the underlying nmcli /
 * NetworkManager exception and stores `str(e)` in `/wifi/error`, then
 * the BLE service forwards it verbatim through `WIFI_STATUS.error`.
 * Those strings are useful for log triage but unreadable for end users
 * ("Failed to add a new connection: nm-device-error-quark: (7)
 * Connection 'foo' is not available on device wlan0 because device
 * requires a 'wifi' connection but profile is 'wifi'").
 *
 * Rather than ask the daemon to translate (and force a daemon-side
 * release for any new pattern we discover in the field), we keep the
 * raw string on the wire and humanise on the device. We always
 * return the raw string alongside so the UI can offer "Show details"
 * and we never lose information for support sessions.
 *
 * Pattern matching is deliberately conservative: we only short-circuit
 * to a friendly headline when the raw string contains an
 * unambiguously-diagnostic substring. Anything we don't recognise
 * falls through to the generic "Couldn't join the network" headline,
 * with the raw text presented underneath.
 */

import type { WifiProbeResult } from '../types/robot';

export interface HumanizedError {
  /** Short, actionable headline. Always present. */
  headline: string;
  /** The raw error string from the daemon. `null` when the failure
   * happened entirely client-side (e.g. BLE write timeout) and we
   * already encoded it in the headline. */
  raw: string | null;
  /** True when we recognised the error pattern. UIs can use this to
   * decide whether to render the raw text under a "details" disclosure
   * vs surface it directly. */
  recognised: boolean;
}

/**
 * Map a free-form Wi-Fi error string (typically the daemon's
 * `WIFI_STATUS.error`) to a stable, user-readable summary.
 *
 * The heuristics target NetworkManager / nmcli / wpa_supplicant
 * messages we have seen in the field. Order matters: more specific
 * matches come first so a generic "timeout" doesn't pre-empt the
 * password-related ones.
 */
export function humanizeWifiError(raw: string | null | undefined): HumanizedError {
  if (!raw || !raw.trim()) {
    return {
      headline: 'Wi-Fi setup failed',
      raw: null,
      recognised: false,
    };
  }

  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  // ─── Wrong password / auth failure ─────────────────────────────
  // wpa_supplicant + nm both surface the password failure with one
  // of these markers. "secrets were required" is the classic nmcli
  // message; "802-11" / "802-1x" point at the auth handshake.
  if (
    lower.includes('secrets were required') ||
    lower.includes('802-11-wireless-security') ||
    lower.includes('802-1x') ||
    lower.includes('psk') ||
    lower.includes('authentication failed') ||
    lower.includes('wrong password') ||
    lower.includes('no key available')
  ) {
    return {
      headline: 'Incorrect Wi-Fi password',
      raw: trimmed,
      recognised: true,
    };
  }

  // ─── SSID not found in scan ────────────────────────────────────
  if (
    lower.includes('not found in scan') ||
    lower.includes('no network with ssid') ||
    lower.includes('ssid not found') ||
    lower.includes('access point not found')
  ) {
    return {
      headline: 'Network out of range',
      raw: trimmed,
      recognised: true,
    };
  }

  // ─── Device busy / NM not ready ────────────────────────────────
  if (
    lower.includes('device is busy') ||
    lower.includes('not allowed by device') ||
    lower.includes('not available on device') ||
    lower.includes('device is not ready')
  ) {
    return {
      headline: 'Robot was busy, try again',
      raw: trimmed,
      recognised: true,
    };
  }

  // ─── DHCP / IP acquisition ─────────────────────────────────────
  if (
    lower.includes('dhcp') ||
    lower.includes('failed to acquire') ||
    lower.includes('ip configuration could not be reserved')
  ) {
    return {
      headline: 'Connected but no IP from the router',
      raw: trimmed,
      recognised: true,
    };
  }

  // ─── Timeout (connection-attempt watchdog) ────────────────────
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return {
      headline: 'Network is too slow to respond',
      raw: trimmed,
      recognised: true,
    };
  }

  // ─── Daemon couldn't talk to itself (BLE bridge meta-error) ──
  if (lower.includes('daemon_unreachable') || lower.includes('daemon unreachable')) {
    return {
      headline: 'Robot daemon is not responding',
      raw: trimmed,
      recognised: true,
    };
  }

  // ─── Generic NM "activation failed" - we know it failed but
  //     have nothing more specific. Don't claim "wrong password"
  //     because ~half the time it's something else (e.g. AP busy
  //     during association).
  if (
    lower.includes('activation failed') ||
    lower.includes('failed to add a new connection')
  ) {
    return {
      headline: "Couldn't join the network",
      raw: trimmed,
      recognised: true,
    };
  }

  // ─── Fallthrough ───────────────────────────────────────────────
  return {
    headline: 'Wi-Fi setup failed',
    raw: trimmed,
    recognised: false,
  };
}

// ===========================================================================
// Probe summary
// ===========================================================================

/**
 * Produce a single-sentence summary of a `WIFI_PROBE` snapshot.
 *
 * The probe runs five layers: `wlan` (link), `gateway` (LAN), `dns`,
 * `internet`, `daemon` (loopback to FastAPI). The summary follows the
 * "lowest broken layer wins" rule: the user only needs to fix the
 * earliest failing hop, anything downstream is necessarily affected.
 *
 * Returns `null` when the probe is fully green AND the caller has
 * indicated this isn't a failure context (we don't render a "all
 * green" headline on top of an "all green" probe table - that would
 * be redundant).
 */
export function summarizeProbeResult(
  result: WifiProbeResult,
): { headline: string; hint: string } | null {
  const isOk = (v: string): boolean => v === 'ok';
  const isPending = (v: string): boolean => v === 'timeout' || v === 'unknown';

  // Walk the stack top-down: link → gateway → dns → internet → daemon.
  if (!isOk(result.wlan)) {
    if (result.wlan === 'down') {
      return {
        headline: 'Wi-Fi not connected',
        hint: 'The robot is not associated with any Wi-Fi network. Try the setup again with the correct password.',
      };
    }
    return {
      headline: 'Wi-Fi link error',
      hint: 'The robot couldn\'t reach the Wi-Fi hardware. A power cycle of the robot usually fixes this.',
    };
  }

  if (!isOk(result.gateway) && !isPending(result.gateway)) {
    return {
      headline: 'Router is unreachable',
      hint: 'The robot is on Wi-Fi but can\'t talk to your router. Move the robot closer or check the router.',
    };
  }

  if (!isOk(result.dns) && !isPending(result.dns)) {
    return {
      headline: 'DNS is broken',
      hint: 'The robot can talk to your router but name resolution fails. Check your router\'s DNS settings (try 1.1.1.1 / 8.8.8.8).',
    };
  }

  if (!isOk(result.internet) && !isPending(result.internet)) {
    return {
      headline: 'Internet is unreachable',
      hint: 'The robot is on Wi-Fi and DNS works, but it can\'t reach Hugging Face. Your network may block external traffic.',
    };
  }

  if (!isOk(result.daemon) && !isPending(result.daemon)) {
    return {
      headline: 'Robot daemon is wedged',
      hint: 'The Wi-Fi side is healthy but the robot\'s internal service is stuck. Reboot the robot to recover.',
    };
  }

  // All probes green (or pending). Surface a "looks fine" headline
  // when there's at least one pending row, otherwise return null and
  // let the caller render whatever generic message it had.
  const anyPending =
    isPending(result.wlan) ||
    isPending(result.gateway) ||
    isPending(result.dns) ||
    isPending(result.internet) ||
    isPending(result.daemon);

  if (anyPending) {
    return {
      headline: 'Network looks healthy, but…',
      hint: 'Some checks didn\'t complete in time. Try the setup again - it might just have been transient.',
    };
  }

  return null;
}
