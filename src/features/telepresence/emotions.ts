/**
 * Emotions the telepresence operator can trigger while driving the base.
 *
 * Kept few and calm on purpose: on the wheeled base the head is part of
 * the balancing load, and pitch (nodding) is the axis the base balances
 * on. Measured head ranges over each move:
 *
 *   simple_nod   1.8 s  pitch 40°              (the reference nod)
 *   welcoming1   3.5 s  pitch 1.5°, roll 36°   (side tilt, off the balance axis)
 *   serenity1    4.6 s  pitch 0.1°, z 3.5 mm   (antennas, almost no head motion)
 */
export interface TelepresenceEmotion {
  id: string;
  label: string;
  emoji: string;
  /** Move name in `dataset`. */
  move: string;
  dataset: string;
  durationS: number;
}

const DANCES = 'pollen-robotics/reachy-mini-dances-library';
const EMOTIONS = 'pollen-robotics/reachy-mini-emotions-library';

export const TELEPRESENCE_EMOTIONS: readonly TelepresenceEmotion[] = [
  { id: 'nod', label: 'Nod', emoji: '🙂', move: 'simple_nod', dataset: DANCES, durationS: 1.8 },
  { id: 'hello', label: 'Hello', emoji: '👋', move: 'welcoming1', dataset: EMOTIONS, durationS: 3.5 },
  { id: 'calm', label: 'Calm', emoji: '😌', move: 'serenity1', dataset: EMOTIONS, durationS: 4.6 },
];
