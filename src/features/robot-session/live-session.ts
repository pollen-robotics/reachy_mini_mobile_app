/**
 * `LiveSession` - the capability the connection layer hands to the
 * conversation layer once (and only once) a WebRTC session is up.
 *
 * Why this exists
 * ───────────────
 * The conversation pipeline (motion, tools, realtime backend, vision)
 * needs to talk to the live robot, but it must NOT own the transport
 * lifecycle (connect / wake / release / reacquire / teardown). That is
 * the `RobotSession` + connection layer's job.
 *
 * `LiveSession` is the narrow seam between the two: the connection
 * layer produces one when it reaches its `live` state and revokes it
 * when the session is lost. The conversation layer depends ONLY on
 * this interface, never on `RobotSession` or the SDK `robot` ref
 * directly. That keeps "who decides a robot is reachable" (connection)
 * cleanly separated from "what we do with a reachable robot"
 * (conversation), which is the whole point of the decoupling.
 *
 * Scope (intentionally minimal)
 * ─────────────────────────────
 *   - `getRobot()`        the live SDK ref the conversation pipeline
 *                         drives (head poses, tool moves, mic track,
 *                         data-channel health). Returns `null` when no
 *                         session is up so every consumer degrades to
 *                         a no-op instead of crashing.
 *   - `getVideoStream()`  the cached camera stream for the on-demand
 *                         `look` vision tool.
 *
 * Fields wired in later steps of the decoupling:
 *   - `daemonVersion`     resolved during bring-up, used by the
 *                         version gate (step 5).
 *   - `epoch`             bumped on every loss/release so late async
 *                         callbacks from a previous session can detect
 *                         staleness (step 4).
 */

import type { ReachyMiniInstance } from './sdk-types';
import type { RobotSession } from './RobotSession';

export interface LiveSession {
  /** Live SDK transport ref, or `null` when no session is up. */
  getRobot(): ReachyMiniInstance | null;
  /** Cached camera `MediaStream` for the on-demand vision tool, or
   *  `null` when no frame has been received yet. */
  getVideoStream(): MediaStream | null;
}

/**
 * Build a `LiveSession` view over a `RobotSession`. Both accessors
 * delegate to the session (the canonical owner of the SDK ref + the
 * video cache), so the view always reflects the current live robot
 * without capturing a stale value.
 */
export function createLiveSession(session: RobotSession): LiveSession {
  return {
    getRobot: () => session.getRobot(),
    getVideoStream: () => session.videoCache.get(),
  };
}
