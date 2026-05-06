/**
 * Robot data-channel health monitor.
 *
 * The audio WebRTC link to the robot is native and usually keeps
 * going across background periods. The DATA channel (which carries
 * head poses, antennas, `sendRaw` commands) is more fragile: some
 * routers / the SDK itself can close it after idle timeouts, in
 * which case motion commands land in the void and we'd never notice
 * because we weren't checking the SDK's boolean return values.
 *
 * Two responsibilities:
 *   - `recordSend()`  - count motion-command ack failures and
 *                       escalate to a fatal error after a streak.
 *   - `probeRobotLink()` - ping the robot with a no-op command on
 *                       visibility return to verify the channel
 *                       is still live.
 *
 * The module is built around a small dependency surface (a robot
 * getter + a fatal-error callback) so the engine can wire it up at
 * mount time without exposing the rest of its state.
 */

import type { ReachyMiniInstance } from "../globals";

export interface DcHealthDeps {
  /** Live robot instance. Returns null while the engine is in a
   *  pre-connect state - probes / records during that window are
   *  no-ops. */
  getRobot: () => ReachyMiniInstance | null;
  /** Fired when the link is judged definitively dead. The engine
   *  uses this to flip the FSM to `error`. */
  onFatalLink: (err: Error) => void;
}

export interface DcHealthMonitor {
  /** Record the outcome of a motion send. Each agent (wobbler,
   *  antennas, move-player, raw sends) calls this so we can detect
   *  a string of failures and surface the issue rather than moving
   *  "silently" forever. */
  recordSend: (ok: boolean, where: string) => void;
  /** Ping the robot with a no-op command to verify the data channel
   *  is still live. Called on visibility return when a session is
   *  active. */
  probeRobotLink: () => Promise<void>;
  /** Reset the failure counter. Called on a fresh session start so
   *  a previous flaky session doesn't poison the new one. */
  reset: () => void;
}

const FAILURE_FATAL_THRESHOLD = 40;
const FAILURE_LOG_INTERVAL = 20;

export function createDcHealthMonitor(deps: DcHealthDeps): DcHealthMonitor {
  let consecutiveSendFailures = 0;

  const recordSend = (ok: boolean, where: string): void => {
    if (ok) {
      consecutiveSendFailures = 0;
      return;
    }
    consecutiveSendFailures += 1;
    if (
      consecutiveSendFailures === 1 ||
      consecutiveSendFailures % FAILURE_LOG_INTERVAL === 0
    ) {
      console.warn(
        `[dc-health] robot send failed (${where}), ${consecutiveSendFailures} consecutive failures`,
      );
    }
    if (consecutiveSendFailures >= FAILURE_FATAL_THRESHOLD) {
      deps.onFatalLink(
        new Error(
          "Lost the robot data channel (no commands acknowledged). " +
            "Tap the circle to reconnect.",
        ),
      );
    }
  };

  const probeRobotLink = async (): Promise<void> => {
    const robot = deps.getRobot();
    if (!robot) return;
    // Neutral antennas is a safe "heartbeat" - won't move the robot
    // unless the oscillator was frozen at a non-zero pose, in which
    // case the next tick overwrites this one anyway.
    const ok = robot.setAntennasDeg(0, 0);
    if (!ok) {
      console.warn(
        "[dc-health] robot data channel appears dead after visibility return",
      );
      recordSend(false, "probeRobotLink");
      // Force-escalate even if we haven't hit the threshold yet:
      // this is a clear signal the channel is gone.
      deps.onFatalLink(
        new Error(
          "Lost the robot data channel while the tab was hidden. " +
            "Tap the circle to reconnect.",
        ),
      );
    }
  };

  const reset = (): void => {
    consecutiveSendFailures = 0;
  };

  return { recordSend, probeRobotLink, reset };
}
