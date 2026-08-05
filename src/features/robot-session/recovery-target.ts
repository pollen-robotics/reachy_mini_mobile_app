/**
 * Dial-target resolution for in-place session recovery.
 *
 * Why this exists: the peer id a client dials is the CENTRAL
 * registration id of the robot's daemon, and it changes every time
 * the daemon restarts. So after the most interesting class of fatal
 * (robot rebooted, daemon crashed and came back), re-dialing the id
 * we originally connected with can never succeed - the robot is
 * back on central under a fresh id. Recovery must therefore
 * re-resolve the target against the freshest `robotsChanged`
 * snapshot: exact id when still listed, otherwise a name match.
 *
 * Pure resolution + a bounded polling wait, split from the engine so
 * both are unit-testable without an SDK.
 */
import type { RobotInfo } from './sdk-types';

/**
 * Resolve the peer id to dial from a robots snapshot. Returns `null`
 * when the robot (by id or name) isn't listed - the caller decides
 * whether to wait for it to reappear or give up.
 */
export function resolveRecoveryTarget(
  known: readonly RobotInfo[],
  robotId: string,
  robotName?: string | null,
): string | null {
  if (known.some((r) => r.id === robotId)) return robotId;
  if (robotName) {
    const byName = known.find((r) => r.meta?.name === robotName);
    if (byName) return byName.id;
  }
  return null;
}

export interface WaitForRecoveryTargetOptions {
  /** Freshest robots snapshot, re-read on every poll tick. */
  getKnownRobots: () => readonly RobotInfo[];
  robotId: string;
  robotName?: string | null;
  /** Total budget before giving up. Sized for a daemon restart:
   *  process boot + central re-registration is typically 5-20 s. */
  timeoutMs?: number;
  pollMs?: number;
  /** Bail out early (host unmounted / user left the screen). */
  isCancelled?: () => boolean;
}

/**
 * Poll the robots snapshot until the target robot is dialable, the
 * budget runs out, or the caller cancels. Resolves with the peer id
 * to dial, or `null` on timeout/cancel.
 */
export async function waitForRecoveryTarget({
  getKnownRobots,
  robotId,
  robotName,
  timeoutMs = 15_000,
  pollMs = 500,
  isCancelled,
}: WaitForRecoveryTargetOptions): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isCancelled?.()) return null;
    const target = resolveRecoveryTarget(getKnownRobots(), robotId, robotName);
    if (target) return target;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
