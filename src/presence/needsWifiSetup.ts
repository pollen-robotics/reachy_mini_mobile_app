/**
 * Heuristic: should tapping this robot route directly to the Wi-Fi
 * setup flow instead of attempting a regular session handshake?
 *
 * Why this exists
 * ───────────────
 * Before this helper, tapping a robot with a "Setup pending" chip
 * meant:
 *
 *     Scan tap
 *       → RobotSessionScreen
 *           → handshake starts
 *               → LAN probe fails (the robot has no LAN!)
 *                   → HandshakeFailureView with `offerWifiSetup`
 *                       → user taps "Set up Wi-Fi"
 *                           → WifiSetupScreen
 *
 * Three screens, two taps, one flash of "failure" - for a state we
 * already knew at scan time. The chip on the card was literally
 * telling us "this robot needs setup".
 *
 * The fix is simply to short-circuit the routing layer: if the BLE
 * transport's `network_mode` TLV says the robot is not on a real
 * Wi-Fi yet, the only action the user can take is provisioning, so
 * we go there directly.
 *
 * Rules
 * ─────
 * Returns `true` only when ALL of these hold:
 *   1. The robot has a BLE transport (we have a way to talk to its
 *      hotspot for provisioning, otherwise short-circuiting would
 *      strand the user).
 *   2. The BLE TLV `network_mode` is non-null (modern daemon) AND
 *      reports `'hotspot'` or `'offline'`.
 *
 * We deliberately do NOT use the legacy fallback (`!centralPeerIdPrefix`)
 * here, even though the scan-screen chip does. Routing changes are a
 * harder commitment than a chip; on a legacy daemon we'd rather
 * over-trust and let the handshake try (and surface the existing
 * "Set up Wi-Fi" failure UI) than route a perfectly-fine robot to
 * setup.
 */
import type { AggregatedRobot } from './aggregatedRobot';
import { isBleTransport } from './aggregatedRobot';

export function needsWifiSetup(robot: AggregatedRobot): boolean {
  const ble = robot.transports.find(isBleTransport);
  if (!ble) return false;

  const mode = ble.device.networkMode;
  // Modern daemon: trust the TLV. `null` means a legacy daemon that
  // doesn't publish the bit yet - fall through and let the regular
  // routing run (it will eventually surface the "Set up Wi-Fi"
  // affordance via HandshakeFailureView if the LAN probe fails).
  if (mode === null) return false;

  return mode !== 'connected';
}
