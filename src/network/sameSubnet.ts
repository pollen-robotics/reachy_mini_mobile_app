/**
 * Heuristics to decide whether two IPs are likely to be mutually reachable
 * without going through a router.
 *
 * We deliberately stay IPv4-only and /24-only for the v0:
 *   - Mobile hotspots and home WiFi networks are almost always /24.
 *   - The BLE payload from the daemon is IPv4-only.
 *   - Doing full CIDR math adds code without any real-world gain yet.
 *
 * `null` is returned when either input is malformed, so callers can surface
 * a "we cannot tell" state rather than guessing.
 */
export function sameSubnet24(a: string, b: string): boolean | null {
  const prefixA = toPrefix24(a);
  const prefixB = toPrefix24(b);
  if (prefixA === null || prefixB === null) return null;
  return prefixA === prefixB;
}

/**
 * Given a list of phone IPs and a robot IP, return whether *any* interface
 * is on the same /24 as the robot.
 */
export function phoneIsOnSameSubnet(
  phoneIps: ReadonlyArray<string>,
  robotIp: string
): boolean {
  return phoneIps.some(ip => sameSubnet24(ip, robotIp) === true);
}

function toPrefix24(ip: string): string | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  }
  return parts.slice(0, 3).join('.');
}
