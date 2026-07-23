/**
 * Shell-owned emote controller for the first wake-up wizard.
 *
 * The wizard shell stays mounted for the whole flow, so it - not the individual
 * steps - drives each step's entry emote. A step's emote is fired as a
 * navigation EVENT (from `goNext`, i.e. a user click or auto-advance),
 * never from a step's mount `useEffect(..., [])`.
 *
 * Why this matters (Wi-Fi flicker): a mount effect is double-invoked by
 * StrictMode (mount -> cleanup -> remount) and can re-run on any remount, so it
 * would send `playRecordedMove` twice within ~1 ms. Over Wi-Fi the data-channel
 * jitter spaces those two sends just enough that the daemon's `is_move_running`
 * guard can miss the second and start BOTH moves - they then fight and the robot
 * judders. Triggering from an event (which React never double-invokes) removes
 * the race at the source, matching how the conversation engine only plays moves
 * from events (LLM tool calls, FSM transitions), never from React mounts.
 *
 * Steps are presentational: they render off `playingStep` / `playedStep` and
 * replay via `play(step)`; they don't own the move, the reveal timer, or the
 * return-to-neutral.
 *
 * Reveal timing is event-driven, not fixed: instead of guessing the move length
 * with a timer, we watch the daemon's `is_move_running` on the pushed pose stream
 * and reveal (+ return to neutral) the instant it falls, i.e. when the move
 * actually ends on the robot. `spec.playMs` survives only as a safety ceiling in
 * case that edge is missed (dropped frames / a move too short to observe).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { STEP_EMOTES, type Step } from './constants';
import { resetToDefaultPose } from './motion';

// Extra time past a move's nominal length (`spec.playMs`) before the safety
// ceiling force-reveals. The event-driven `is_move_running` edge normally fires
// first; this only catches the pathological "we never saw the edge" case, so it
// errs long to avoid cutting a move short.
const MOVE_END_FALLBACK_MS = 2500;

// Ease-in (seconds) for the motor step's wake move when it's replayed while the
// robot is NOT in its sleep pose. The move starts FROM the sleep pose, so
// without an initial goto the robot snaps there before animating (a visible
// jump on replay). Skipped when already asleep - the snap is then a no-op.
const WAKE_EASE_IN_S = 1.0;

export interface StepEmotes {
  /** Step whose entry emote is currently playing (blocking), or null. */
  playingStep: Step | null;
  /** Step whose entry emote has finished - reveal its confirm controls. */
  playedStep: Step | null;
  /**
   * Fire a step's entry emote. Call it on step transition (and from a step's
   * manual "play again"). A no-op for steps without an entry emote, and a no-op
   * on the daemon side if a move is already running (`is_move_running`).
   */
  play: (step: Step) => void;
}

/**
 * @param session Live session handle (robot access + SDK pass-throughs).
 * @param onMotorWake Called when the motor step's wake emote fires, so the shell
 *   can mark the robot woken (and skip replaying the wake on finish).
 * @param isInSleepPose Reads whether the robot is currently in its sleep pose.
 *   The wake move starts FROM the sleep pose, so on a replay while the robot is
 *   already awake we ease into it (initial goto) instead of snapping; when it's
 *   already asleep the snap is a no-op, so we skip the ease.
 */
export function useStepEmotes(
  session: RobotSessionHandle,
  onMotorWake: () => void,
  isInSleepPose: () => boolean,
): StepEmotes {
  const [playingStep, setPlayingStep] = useState<Step | null>(null);
  const [playedStep, setPlayedStep] = useState<Step | null>(null);
  // Safety-ceiling timer: force-reveals if we never see the move-end edge. Only
  // one is pending at a time (one step plays at a time).
  const revealTimer = useRef<number | null>(null);
  // Cancels the pending neutral-pose retries (see `resetToDefaultPose`) so none
  // bleed into the next step or the conversation UI on handoff.
  const cancelReset = useRef<(() => void) | null>(null);
  // Tears down the in-flight emote's move-end watcher (state listener + ceiling
  // timer) and releases its pose subscription. Set while a move plays, cleared
  // on completion; invoked before starting a new emote and on unmount.
  const stopWatch = useRef<(() => void) | null>(null);

  const play = useCallback(
    (step: Step) => {
      const spec = STEP_EMOTES[step];
      if (!spec) return; // welcome / microphone have no entry emote
      const robot = session.getRobot();
      if (!robot) {
        // Robot not ready yet: drop out of "playing" so the step shows its
        // manual "play" button as a retry (which calls back into `play`).
        setPlayingStep(null);
        return;
      }
      // Tear down a previous emote's watcher (and release its pose sub) before
      // starting a new one, so subscriptions stay balanced.
      stopWatch.current?.();
      stopWatch.current = null;

      // The motor step is the deferred first wake: enable torque and tell the
      // shell the robot is now awake (so it won't replay the wake on finish).
      if (step === 'motor') {
        robot.setMotorMode('enabled');
        onMotorWake();
      }
      // Subscribe so `is_move_running` arrives at ~30 Hz (a crisp move-end edge)
      // even on steps without the 3D mirror. Refcounted in the SDK, so it
      // composes with the mirror's own subscription.
      robot.subscribePose();
      // Ease into the wake move's start (sleep) pose only when the robot isn't
      // already there, so a replay-while-awake glides in instead of jumping.
      const initialGotoDuration =
        step === 'motor' && !isInSleepPose() ? WAKE_EASE_IN_S : 0;
      robot.playRecordedMove(spec.move.name, {
        ...(spec.move.dataset ? { dataset: spec.move.dataset } : {}),
        ...(initialGotoDuration > 0 ? { initialGotoDuration } : {}),
      });
      setPlayedStep(null);
      setPlayingStep(step);

      // Watch the move to completion: `is_move_running` first rises (the daemon
      // picked up our play), then falls (the move ended). We reveal on that fall
      // - not on the initial idle frames before the move starts, hence the
      // `sawRunning` latch.
      let sawRunning = false;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        robot.removeEventListener('state', onState);
        if (revealTimer.current !== null) {
          window.clearTimeout(revealTimer.current);
          revealTimer.current = null;
        }
        stopWatch.current = null;
        setPlayingStep(cur => (cur === step ? null : cur));
        setPlayedStep(step);
        // The move just ended, so a single daemon-side goto lands cleanly.
        cancelReset.current = resetToDefaultPose(session, { retries: 0 });
        robot.unsubscribePose();
      };
      const onState = (e: Event) => {
        const running = (e as CustomEvent<{ is_move_running?: boolean }>).detail
          ?.is_move_running;
        if (running) sawRunning = true;
        else if (sawRunning) finish();
      };
      robot.addEventListener('state', onState);

      // Safety ceiling (see MOVE_END_FALLBACK_MS): if the edge is missed, reveal
      // anyway so the step never hangs on "playing".
      revealTimer.current = window.setTimeout(
        finish,
        spec.playMs + MOVE_END_FALLBACK_MS,
      );

      stopWatch.current = () => {
        done = true;
        robot.removeEventListener('state', onState);
        if (revealTimer.current !== null) {
          window.clearTimeout(revealTimer.current);
          revealTimer.current = null;
        }
        robot.unsubscribePose();
      };
    },
    [session, onMotorWake, isInSleepPose],
  );

  useEffect(
    () => () => {
      stopWatch.current?.();
      cancelReset.current?.();
    },
    [],
  );

  return { playingStep, playedStep, play };
}
