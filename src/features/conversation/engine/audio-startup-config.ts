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

import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";

export type AudioStartupParameter = { name: string; values: number[] };

/**
 * Values copied verbatim from
 * pollen-robotics/reachy_mini_conversation_app@85ba8f8
 * `src/reachy_mini_conversation_app/audio/startup_config.py` — these
 * were tuned against the Realtime voice loop so we keep them in lockstep.
 */
export const AUDIO_STARTUP_CONFIG: ReadonlyArray<AudioStartupParameter> = [
  { name: "PP_AGCMAXGAIN", values: [10.0] },
  { name: "PP_MIN_NS", values: [0.8] },
  { name: "PP_MIN_NN", values: [0.8] },
  { name: "PP_GAMMA_E", values: [0.5] },
  { name: "PP_GAMMA_ETAIL", values: [0.5] },
  { name: "PP_NLATTENONOFF", values: [0] },
  { name: "PP_MGSCALE", values: [4.0, 1.0, 1.0] },
];

/**
 * Apply the tuned XVF3800 startup config. Never throws — a missing
 * audio board is the common case on Lite robots and must not break
 * the conversation flow.
 */
export async function applyAudioStartupConfig(
  robot: ReachyMiniInstance,
): Promise<boolean> {
  try {
    const applied = await robot.applyAudioConfig(AUDIO_STARTUP_CONFIG, {
      verify: true,
    });
    if (!applied) {
      console.warn(
        "[audio-startup-config] not applied (no XVF3800 board, or a write/verify failed)",
      );
    }
    return applied;
  } catch (err) {
    console.warn("[audio-startup-config] apply failed:", err);
    return false;
  }
}
