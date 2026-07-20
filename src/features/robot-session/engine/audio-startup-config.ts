/**
 * Mobile-side mirror of `reachy_mini_conversation_app/audio/startup_config.py`.
 *
 * Writes a tuned batch of XVF3800 parameters once the WebRTC DataChannel
 * is live and the robot has woken up. Without this batch the mic is too
 * quiet for the realtime voice loop and the noise gate is overly
 * aggressive — see issue #21 / upstream PR #1058.
 *
 * Best-effort: a missing audio board (Lite / dev / loose USB cable) is
 * surfaced as a warning and the conversation continues as before.
 */

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

export type AudioStartupParameter = { name: string; values: number[] };

/**
 * Values kept in lockstep with the on-robot conversation app's
 * `src/reachy_mini_conversation_app/audio/startup_config.py`.
 *
 * Note: the previous mobile values were pinned to an old commit
 * (@85ba8f8) that used a 4x mic gain (`PP_MGSCALE=[4,1,1]`) with the
 * non-linear echo suppressor OFF (`PP_NLATTENONOFF=0`). Upstream has
 * since reverted both: the robot's mic and speaker sit a few cm apart
 * in the same shell, so the 4x boost fed residual speaker echo straight
 * into the realtime VAD (the robot barged in on itself) and the linear
 * AEC alone left too much residual. We now mirror the current upstream:
 * unity mic gain + NLP on.
 */
export const AUDIO_STARTUP_CONFIG: ReadonlyArray<AudioStartupParameter> = [
  // Mobile-specific deviation from the on-robot app (which uses 10.0):
  // the phone use-case is far-field (user not leaning over the robot),
  // so we let the *adaptive* AGC apply more make-up gain to quiet /
  // distant speech. This is preferred over a higher fixed mic gain
  // (`PP_MGSCALE`) because the AGC only boosts when the signal is low,
  // and the non-linear echo suppressor below stays ON to keep the
  // robot's own TTS from being amplified into a false barge-in.
  { name: 'PP_AGCMAXGAIN', values: [16.0] },
  { name: 'PP_MIN_NS', values: [0.8] },
  { name: 'PP_MIN_NN', values: [0.8] },
  { name: 'PP_GAMMA_E', values: [0.5] },
  { name: 'PP_GAMMA_ETAIL', values: [0.5] },
  // Non-linear echo suppressor ON: without it the robot hears its own
  // TTS through the in-shell speaker and barges in on itself.
  { name: 'PP_NLATTENONOFF', values: [1] },
  // Unity mic gain. A 4x boost on the first channel amplified the
  // residual echo straight into the realtime VAD.
  { name: 'PP_MGSCALE', values: [1.0, 1.0, 1.0] },
];

/**
 * Apply the tuned XVF3800 startup config. Never throws — a missing
 * audio board is the common case on Lite robots and must not break
 * the conversation flow.
 */
export async function applyAudioStartupConfig(robot: ReachyMiniInstance): Promise<boolean> {
  try {
    const applied = await robot.applyAudioConfig(AUDIO_STARTUP_CONFIG, {
      verify: true,
    });
    if (!applied) {
      console.warn(
        '[audio-startup-config] not applied (no XVF3800 board, or a write/verify failed)'
      );
    }
    return applied;
  } catch (err) {
    console.warn('[audio-startup-config] apply failed:', err);
    return false;
  }
}
