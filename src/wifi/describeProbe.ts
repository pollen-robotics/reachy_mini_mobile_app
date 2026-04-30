/**
 * Translate a `WIFI_PROBE` verdict into a precise, actionable user
 * message.
 *
 * Why this is shared
 * ──────────────────
 * The same kind of precise, "robot's-own-perspective" diagnosis is
 * useful in two places:
 *
 *   - `WifiSetupScreen` after the robot reports `mode=wlan` (initial
 *     provisioning).
 *   - `RobotSessionScreen` when the regular handshake fails and we
 *     happen to have a BLE transport available, so we can swap the
 *     generic "Couldn't reach the daemon" for a precise reason.
 *
 * Both flows want the same human translation table. Keeping it here
 * means a single source of truth for copy + a single place to grow it
 * as we add probe fields.
 *
 * The default message ("Almost there - same Wi-Fi?") is correct only
 * when the robot has full connectivity but the phone is on the wrong
 * network. The probe lets us say much better things in the other
 * common cases:
 *
 *   - daemon=loading  : robot finished joining but is still booting,
 *                       just wait
 *   - daemon=fail     : daemon didn't come back after the join
 *   - gateway=fail    : robot has a Wi-Fi link but no DHCP / no IP
 *   - dns/internet    : robot can't reach public hosts (captive portal,
 *                       restricted DNS, …)
 *
 * We never lie: if the probe is `null` (BLE error) or `'unsupported'`
 * (legacy daemon), we keep the original generic copy.
 */
import type { BleWifiProbe } from '../types/robot';

export interface ProbeMessage {
  /** Short one-line title shown above the body. */
  title: string;
  /** Longer explanation + suggested action. */
  body: string;
  /**
   * Severity. Drives icon / colour choices on the consumer side.
   *   - `'info'`    : transient state, the user shouldn't have to act.
   *   - `'warning'` : actionable, the user can fix it.
   *   - `'error'`   : something is genuinely broken (daemon crashed).
   * Falls back to `'warning'` for the generic "same Wi-Fi?" message
   * because we don't know whether the user is on the wrong Wi-Fi or
   * the phone has lost its network.
   */
  severity: 'info' | 'warning' | 'error';
}

export function describeProbeRefinement(
  verdict: BleWifiProbe | 'unsupported' | null
): ProbeMessage {
  const fallback: ProbeMessage = {
    title: 'Almost there',
    body:
      "The robot is online but this phone can't reach it yet. Make sure your phone is on the same Wi-Fi network, then tap Retry.",
    severity: 'warning',
  };
  if (verdict === null || verdict === 'unsupported') return fallback;

  if (verdict.daemon === 'loading') {
    return {
      title: 'Robot is finishing boot',
      body:
        "The robot joined the network and its daemon is still loading. We'll continue automatically as soon as it's ready - no action needed.",
      severity: 'info',
    };
  }

  if (verdict.daemon === 'fail') {
    return {
      title: "Daemon didn't come back",
      body:
        "The robot joined the Wi-Fi but its software didn't restart cleanly. Power-cycle the robot, then retry from the scan screen.",
      severity: 'error',
    };
  }

  if (verdict.gateway === 'fail') {
    return {
      title: 'Robot has no IP yet',
      body:
        "The robot joined the Wi-Fi but the router hasn't handed out an IP address. Check your router's DHCP settings, then tap Retry.",
      severity: 'warning',
    };
  }

  if (verdict.dns === 'fail' || verdict.internet === 'fail') {
    return {
      title: "Robot can\u2019t reach the internet",
      body:
        "The robot is on the Wi-Fi but can't reach public hosts. This is usually a captive portal or a router with restricted DNS. Pick a different network from the scan screen.",
      severity: 'warning',
    };
  }

  return fallback;
}
