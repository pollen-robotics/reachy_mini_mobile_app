/**
 * Shared constants for the first wake-up wizard.
 *
 * Step ordering, copy targets and the per-step troubleshooting tips live
 * here so the shell, the router and the individual step files all read
 * from one source of truth.
 */

/** Public troubleshooting docs + community support, shown in the footer of
 *  every per-step troubleshooting view. */
export const FAQ_URL = 'https://huggingface.co/docs/reachy_mini/troubleshooting';
export const DISCORD_URL = 'https://discord.gg/pollen-robotics';

/**
 * Onboarding-specific moves (wake / waiting / deep-sleep / toc-toc-toc) don't
 * live in the default emotions library yet - they ship in this dataset.
 * TEMPORARY: drop the per-move `dataset` override once they're merged into
 * `pollen-robotics/reachy-mini-emotions-library`.
 */
export const ONBOARDING_MOVES_DATASET = 'Anne-Charlotte/new-emotions';

/**
 * Recorded emotion moves (motion + bundled sound) played per step over the
 * WebRTC session via `playRecordedMove`. Moves without a `dataset` come from the
 * robot's pre-downloaded default library; the overrides point at the onboarding
 * dataset above. `motor` (Meet Me) plays ON THE BUTTON only; the others
 * play once on step entry. `speaker` uses the default (untrimmed) `proud2`.
 */
export const STEP_MOVES = {
  motor: { name: 'wake-mini-up', dataset: ONBOARDING_MOVES_DATASET },
  camera: { name: 'curious1' },
  speaker: { name: 'proud2' },
} as const;

/**
 * Closing emotion played when the wizard's last step is confirmed (there's no
 * dedicated success screen anymore). Lives in the default emotions library, so
 * no dataset override. Runs in parallel with the celebration overlay handoff.
 */
export const FINISH_MOVE = 'welcoming2';

/**
 * Duration of the `FINISH_MOVE` animation (~4.33 s measured from its recorded
 * timestamps). The closing celebration overlay stays up for this long so it
 * covers the robot for the full move instead of cutting away mid-animation.
 * Keep in sync if `FINISH_MOVE` changes.
 */
export const FINISH_MOVE_MS = 4300;

/**
 * Spread into `playRecordedMove(...)` so a step move can optionally carry a
 * dataset: `robot.playRecordedMove(...stepMoveArgs(STEP_MOVES.camera))`.
 */
export function stepMoveArgs(move: {
  name: string;
  dataset?: string;
}): [string, { dataset: string }?] {
  return move.dataset ? [move.name, { dataset: move.dataset }] : [move.name];
}

/**
 * How long Meet Me keeps the button disabled ("Moving…") before revealing the
 * confirm controls. `playRecordedMove` is fire-and-forget (no completion ack),
 * so we size this to the actual `wake-mini-up` move duration (~15.7 s measured
 * from its recorded timestamps) plus a small buffer for dispatch latency, so
 * the button doesn't re-enable while the robot is still moving. Keep in sync if
 * the move changes.
 */
export const MEET_ME_REVEAL_MS = 16200;

/**
 * How long the speaker check keeps its button disabled (spinner, "Playing…")
 * after a tap, covering the `proud2` move + its (now untrimmed) sound.
 * `playRecordedMove` is fire-and-forget (no completion ack), so this is a timer.
 * Measured from the HF dataset: motion ~3.18 s, sound ~3.52 s → size to the
 * longer (sound) plus a small dispatch buffer so the button never re-enables
 * while the sound is still playing.
 */
export const SPEAKER_PLAY_MS = 4000;

/**
 * How long the camera step keeps its confirm button disabled (spinner) for the
 * `curious1` move it plays on entry. The button also waits for the first video
 * frame, so it enables only once BOTH the move finished AND the feed is live.
 * Measured from the HF dataset: motion ~11.78 s, sound ~9.94 s → size to the
 * longer (motion) plus a small dispatch buffer.
 */
export const CAMERA_PLAY_MS = 12000;

/** Ordered steps. Drives both the router and the progress bar. The last step
 *  finishes the wizard (no dedicated success screen). */
export const STEPS = ['welcome', 'microphone', 'motor', 'camera', 'speaker'] as const;
export type Step = (typeof STEPS)[number];

/**
 * Per-step ENTRY emote (recorded move + bundled sound), fired by the wizard
 * shell as a navigation EVENT on step transition - never from a step's mount
 * effect. Triggering on the transition (a user click / auto-advance, i.e. an
 * event) rather than on `useEffect(..., [])` means StrictMode can't double-fire
 * it and no component-lifecycle race can start two overlapping moves on Wi-Fi.
 * Mirrors how the conversation engine only ever plays moves from events.
 *
 * `playMs` sizes how long the step keeps its confirm button disabled
 * ("Moving…"/"Playing…") since `playRecordedMove` is fire-and-forget (no
 * completion ack). Steps without an entry emote (welcome, microphone) are
 * intentionally absent.
 */
export const STEP_EMOTES: Partial<
  Record<Step, { move: { name: string; dataset?: string }; playMs: number }>
> = {
  motor: { move: STEP_MOVES.motor, playMs: MEET_ME_REVEAL_MS },
  camera: { move: STEP_MOVES.camera, playMs: CAMERA_PLAY_MS },
  speaker: { move: STEP_MOVES.speaker, playMs: SPEAKER_PLAY_MS },
};

/** Steps that own a "X doesn't work" troubleshooting view. */
export type TroubleStep = 'microphone' | 'motor' | 'speaker' | 'camera';

export const TROUBLE_TIPS: Record<TroubleStep, { title: string; tips: string[] }> = {
  microphone: {
    title: 'Microphone problem',
    tips: [
      'Rub the top of my head or speak louder, right next to me.',
      "Make sure nothing is covering my microphone and that I'm not muted.",
      'Still nothing? A reboot usually clears it up.',
    ],
  },
  motor: {
    title: 'Motors problem',
    tips: [
      'Check my antennas are plugged in correctly (not swapped).',
      'Give me enough space to move freely, then try again.',
      "If I didn't move at all, try rebooting me.",
    ],
  },
  speaker: {
    title: 'Speaker problem',
    tips: [
      "Raise the volume - below 50% I'm barely audible.",
      "Make sure my speaker isn't muted or obstructed.",
      'Still silent? A reboot usually helps.',
    ],
  },
  camera: {
    title: 'Camera problem',
    tips: [
      'Make sure nothing is covering my camera lens.',
      'Give the feed a few seconds to connect.',
      'If it stays black, try rebooting me.',
    ],
  },
};
