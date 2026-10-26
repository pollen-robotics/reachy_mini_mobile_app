/**
 * Plays emotion moves from the Plutchik wheel on the robot.
 *
 * Playback is daemon-side (`play_recorded_move` on the data channel):
 * the robot runs the trajectory locally at 100 Hz - smooth whatever the
 * Wi-Fi does - and plays the move's matching sound from the dataset.
 * It's fire-and-forget, so "playing" is tracked from the daemon's own
 * `is_move_running` flag, with a short grace window to cover the gap
 * between our command and the first state report that sees the move.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { EMOTIONS_DATASET, type EmotionDef } from './plutchik';

const POLL_MS = 250;
/**
 * Time we trust our own "playing" before the daemon confirms it. Some
 * moves start with a ~2 s initial goto before `is_move_running` shows
 * up (measured with `dying1`); a shorter window briefly re-enabled the
 * wheel mid-move.
 */
const START_GRACE_MS = 3000;

export interface EmotionPlayer {
  /** Emotion currently playing (ours), or null. */
  playing: EmotionDef | null;
  /** Any daemon move running (ours or someone else's). */
  busy: boolean;
  /** Returns false when the command couldn't be sent or a move is running. */
  play: (emotion: EmotionDef) => boolean;
}

export function useEmotionPlayer({
  getRobot,
  active,
}: {
  getRobot: () => ReachyMiniInstance | null;
  active: boolean;
}): EmotionPlayer {
  const getRobotRef = useRef(getRobot);
  getRobotRef.current = getRobot;
  const [playing, setPlaying] = useState<EmotionDef | null>(null);
  const [busy, setBusy] = useState(false);
  const startedAtRef = useRef(0);
  const seenRunningRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    const poll = setInterval(() => {
      const running = getRobotRef.current()?.robotState?.is_move_running === true;
      setBusy(running);
      if (running) seenRunningRef.current = true;
      // Done once the daemon reported the move and then stopped, or never
      // picked it up within the grace window.
      const graceOver = Date.now() - startedAtRef.current > START_GRACE_MS;
      if (!running && (seenRunningRef.current || graceOver)) setPlaying(null);
    }, POLL_MS);
    return () => clearInterval(poll);
  }, [active]);

  const play = useCallback((emotion: EmotionDef): boolean => {
    const robot = getRobotRef.current();
    if (!robot || robot.robotState?.is_move_running) return false;
    const sent = robot.playRecordedMove(emotion.id, { dataset: EMOTIONS_DATASET });
    if (sent) {
      startedAtRef.current = Date.now();
      seenRunningRef.current = false;
      setPlaying(emotion);
    }
    return sent;
  }, []);

  return { playing, busy: busy || playing !== null, play };
}
