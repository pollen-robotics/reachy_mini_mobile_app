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

/** Bundled daemon sound used for the speaker check. */
export const TEST_SOUND_FILE = 'count.wav';

/** Ordered steps. Drives both the router and the progress bar. */
export const STEPS = ['welcome', 'microphone', 'motor', 'speaker', 'camera', 'success'] as const;
export type Step = (typeof STEPS)[number];

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
