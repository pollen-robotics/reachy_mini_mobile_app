/**
 * `pickBestTarget` - turn an `AggregatedRobot` (the user-facing
 * unit) into a `ConnectionTarget` (the session-FSM unit).
 *
 * Why this layer matters
 * ──────────────────────
 * Before the aggregator, the discovery code emitted three different
 * `setTarget(...)` calls (`onRobotPicked`, `onLocalhostPicked`,
 * `onRemotePicked`), one per source. Each callback decided not only
 * "which robot" but also "which channel" - and the channel was
 * forever locked to the source the user happened to tap. A robot
 * showing up under both BLE and HF central had to be chosen as the
 * BLE one OR the central one, with no fusion in between.
 *
 * Now the user picks an `AggregatedRobot` and this function maps it
 * to the best `ConnectionTarget` available for that robot. The
 * "wrong robot picked" class of bugs (which is what we hit when a
 * BLE-discovered robot's peer-id resolver fell back to a central
 * stranger) becomes structurally impossible: by the time we reach
 * this function, the robot identity is already settled.
 *
 * Selection policy (default order)
 * ────────────────────────────────
 *   1. `localhost`  - tray on this Mac. Direct loopback HTTP, zero
 *      external dependencies, sub-millisecond latency.
 *   2. `ble`        - LAN BLE handshake. Required when the robot is
 *      not (yet) on Wi-Fi: the BLE channel is the only way to read
 *      `NETWORK_STATUS` and trigger Wi-Fi setup. Even when Wi-Fi is
 *      already up, BLE-first lets the session FSM probe before
 *      committing to a central WebRTC.
 *   3. `central`    - WebRTC via HF central. Works from anywhere
 *      with internet, but the slowest path (full ICE handshake +
 *      relay round-trip) and depends on central being reachable.
 *
 * The aggregator already sorts `robot.transports` in this exact
 * order, so the default implementation just walks the list and
 * picks the first transport. Callers that want to pin a specific
 * transport (e.g. the user explicitly tapped "Connect via BLE" on a
 * detail drawer) pass it via the `prefer` option.
 */
import type { ConnectionTarget } from '../session/sessionFsm';

import type { AggregatedRobot, RobotTransport } from './aggregatedRobot';

export interface PickBestTargetOptions {
  /**
   * Force the selection of a specific transport type. When the
   * robot does not expose this transport, the function returns
   * `null` (the caller should not fall back silently to a different
   * channel - that would defeat the explicit user intent).
   */
  prefer?: RobotTransport['type'];
}

/**
 * Compute the best `ConnectionTarget` for a robot, or `null` when
 * none of the available transports can carry a session.
 *
 * Returns `null` when:
 *   - the robot has no transports (shouldn't happen on a healthy
 *     aggregator output, but defensive),
 *   - the robot is `disabled` (the caller should refuse the tap
 *     anyway, but we double-guard here),
 *   - `prefer` is set and the robot does not expose that transport.
 */
export function pickBestTarget(
  robot: AggregatedRobot,
  options: PickBestTargetOptions = {},
): ConnectionTarget | null {
  if (robot.disabled) return null;
  if (robot.transports.length === 0) return null;

  const candidate = options.prefer
    ? robot.transports.find((t) => t.type === options.prefer)
    : robot.transports[0];
  if (!candidate) return null;

  return transportToTarget(candidate);
}

/**
 * Strict mapping: each transport type produces exactly one
 * `ConnectionTarget` shape. Kept exhaustive over the union via the
 * `never` branch so a future transport addition (e.g. mDNS LAN HTTP)
 * is a compile error here until it's mapped.
 */
function transportToTarget(transport: RobotTransport): ConnectionTarget {
  switch (transport.type) {
    case 'localhost':
      return {
        kind: 'localhost',
        host: transport.daemon.host,
        robotName: transport.daemon.robotName,
        installId: transport.daemon.installId,
        centralPeerId: transport.daemon.centralPeerId,
      };
    case 'ble':
      return { kind: 'local', device: transport.device };
    case 'central':
      return { kind: 'remote', robot: transport.entry };
    default: {
      const _exhaustive: never = transport;
      void _exhaustive;
      throw new Error('pickBestTarget: unhandled transport type');
    }
  }
}

/**
 * Convenience: the ordered list of transport types a robot exposes,
 * useful for chip-rendering in the UI without re-inspecting
 * `transports`.
 */
export function listTransports(
  robot: AggregatedRobot,
): RobotTransport['type'][] {
  return robot.transports.map((t) => t.type);
}
