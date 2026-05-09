/**
 * Shared "the daemon is currently playing a wake / sleep trajectory"
 * flag.
 *
 * The conversation engine's `HeadWobbler` and `AntennasOscillator`
 * push commands at ~30 Hz to the robot. While the daemon is running
 * `wake_up.json` or `goto_sleep.json` those streams must stay silent:
 * the daemon-side controller drops `set_target` / `set_antennas` while
 * a move is active anyway (with an `Ignoring … move running` warning
 * log per dropped frame), so the gate is partly there to spare the
 * round-trips and partly to make the intent explicit on the client.
 *
 * Single boolean, not a counter: `robotMotion`'s reconcile chain
 * serialises wake/sleep so there is at most one active trajectory at a
 * time. Tool-call gestures use `MovePlayer.movePlaying` inside the
 * engine; that flag and this gate are checked together (see
 * `conversation-engine.ts`).
 *
 * Lives in `daemon/` (not `conversation/`) so that `robotMotion.ts`
 * can flip it without pulling in conversation code, which would
 * create an import cycle.
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
