/**
 * Shared "the daemon is currently playing a trajectory" flag.
 *
 * Two unrelated subsystems push commands to the robot at high
 * frequency (~30 Hz):
 *
 *   - The conversation engine's `HeadWobbler` (setHeadPose) and
 *     `AntennasOscillator` (setAntennas).
 *   - The `MovePlayer` driving tool-call gestures.
 *
 * When the daemon is in the middle of a server-side trajectory
 * (e.g. `wake_up.json` or `goto_sleep.json`), those background
 * pushers MUST stay silent: every setHeadPose / setAntennas the
 * SDK forwards as `set_target` / `set_antennas` overrides the
 * trajectory's current frame on the daemon's control loop, which
 * is what produced the "robot moves for 2 s then freezes" bug -
 * the wobbler kept stamping head=identity at 30 Hz on top of the
 * wake-up trajectory.
 *
 * The gate is intentionally a single boolean, not a counter: the
 * trajectories that use it run sequentially through the
 * `robotMotion` reconcile chain, so there is at most one active
 * trajectory at a time. Tool-call moves use `MovePlayer.movePlaying`
 * inside the engine for the same purpose; that flag and this gate
 * are checked together (see `conversation-engine.ts`).
 *
 * Lives in `daemon/` rather than `conversation/` so that
 * `robotMotion.ts` can flip it without pulling in conversation
 * code (which would create a cycle).
 */

let trajectoryPlaying = false;

/**
 * Mark the start / end of a daemon-side trajectory window. The
 * caller is responsible for ALWAYS clearing the flag - wrap the
 * trajectory in a `try { setTrajectoryPlaying(true); ... } finally
 * { setTrajectoryPlaying(false); }` so a failed POST or thrown
 * await doesn't strand the gate.
 */
export function setTrajectoryPlaying(playing: boolean): void {
  trajectoryPlaying = playing;
}

/**
 * Hot path: called from inside the wobbler / antenna 30 Hz tick.
 * Keep cheap (single boolean read).
 */
export function isTrajectoryPlaying(): boolean {
  return trajectoryPlaying;
}
