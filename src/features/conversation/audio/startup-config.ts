/**
 * Audio startup configuration for the Reachy Mini conversation engine.
 *
 * Mirrors the Python helper at
 * `reachy_mini_conversation_app/audio/startup_config.py` (upstream and
 * the local fork) so every conversation surface (mobile app, minimal
 * embedded app, the standalone console app) writes the same tuned
 * XVF3800 parameter set on session start. The values were chosen by
 * the audio team to push the on-device pipeline toward conversational
 * quality (higher AGC ceiling, gentler noise suppression floor, etc.)
 * and SHOULD stay in lockstep across all three apps.
 *
 * Why we ship the values here instead of fetching them from the daemon:
 *   - The daemon's PR #1134 deliberately did NOT bake default values
 *     into the SDK (`reachy_mini.media.audio.apply_audio_config(...)`
 *     is generic). Each app is expected to pass its own tuned set,
 *     matching the on-robot Python conversation app's behaviour.
 *   - Keeping the constants client-side means a tweak doesn't require
 *     a daemon re-flash; we just publish a new app build.
 *
 * Transport
 * ─────────
 * The call rides the WebRTC DataChannel via the JS SDK's
 * `robot.applyAudioConfig(config, { verify })` method (added in
 * upstream PR #1134 of `pollen-robotics/reachy_mini`). We feature-
 * detect the method so this module is a graceful no-op on older SDK
 * builds — the rest of the conversation pipeline keeps working with
 * the daemon's default audio config, just slightly worse-tuned.
 *
 * Timing
 * ──────
 * Call AFTER `session.wakeUp()` resolves (motors on, audio pipelines
 * live) and BEFORE the OpenAI bridge starts streaming, mirroring the
 * Python `console.py` sequence:
 *
 *   start_recording() → start_playing() → sleep(1) → apply_startup_config()
 *
 * The mobile app's WebRTC handshake already brings up the audio
 * streams during `startSession()`, so by the time `wakeUp()` resolves
 * the daemon's pipeline is hot and ready to take parameter writes.
 */
import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";

/**
 * One ``(parameter_name, values)`` pair as accepted by the daemon's
 * `apply_audio_config` command. Values are sent as numbers; the
 * daemon's `AudioControlValue` discriminates int / float server-side
 * based on each parameter's declared type.
 */
export interface AudioStartupParameter {
  name: string;
  values: readonly number[];
}

/**
 * Tuned XVF3800 startup parameters for conversational use. Kept in
 * sync with `reachy_mini_conversation_app/audio/startup_config.py`'s
 * `AUDIO_STARTUP_CONFIG` tuple. Do NOT diverge: an A/B between
 * mobile-app and console-app conversations should sound identical
 * on the same robot, otherwise debugging mic issues becomes
 * platform-specific guesswork.
 */
export const AUDIO_STARTUP_CONFIG: readonly AudioStartupParameter[] = [
  { name: "PP_AGCMAXGAIN", values: [10.0] },
  { name: "PP_MIN_NS", values: [0.8] },
  { name: "PP_MIN_NN", values: [0.8] },
  { name: "PP_GAMMA_E", values: [0.5] },
  { name: "PP_GAMMA_ETAIL", values: [0.5] },
  { name: "PP_NLATTENONOFF", values: [0] },
  { name: "PP_MGSCALE", values: [4.0, 1.0, 1.0] },
];

/**
 * Shape the SDK is expected to expose post-PR #1134. Declared as a
 * narrow structural type so we don't depend on the wider
 * `ReachyMiniInstance` interface picking up the method (it's added
 * as `applyAudioConfig?` on the SDK interface, but at runtime we
 * still feature-detect to stay safe against an older bundled SDK).
 */
interface AudioConfigCapableRobot {
  applyAudioConfig(
    config: readonly AudioStartupParameter[],
    options?: { verify?: boolean },
  ): Promise<boolean>;
}

function hasApplyAudioConfig(
  robot: ReachyMiniInstance | null | undefined,
): robot is ReachyMiniInstance & AudioConfigCapableRobot {
  if (!robot) return false;
  return (
    typeof (robot as Partial<AudioConfigCapableRobot>).applyAudioConfig ===
    "function"
  );
}

/**
 * Apply the tuned XVF3800 startup config to the robot's audio board.
 *
 * Returns `true` if every parameter was written + verified, `false`
 * on any failure path (SDK doesn't expose the method, daemon errors,
 * DataChannel down). Failures are non-fatal: the conversation
 * pipeline keeps going with whatever defaults the daemon shipped
 * with, possibly with degraded mic gain.
 *
 * Safe to call more than once per session (the daemon idempotently
 * writes the same values), but in practice we only invoke it from
 * the post-wakeUp path so it runs at most once per conversation
 * lifetime.
 */
export async function applyAudioStartupConfig(
  robot: ReachyMiniInstance | null | undefined,
): Promise<boolean> {
  if (!hasApplyAudioConfig(robot)) {
    console.warn(
      "[audio-startup] SDK does not expose applyAudioConfig() yet - " +
        "skipping XVF3800 tuning (mic stays on daemon defaults).",
    );
    return false;
  }

  try {
    const applied = await robot.applyAudioConfig(AUDIO_STARTUP_CONFIG, {
      verify: true,
    });
    if (applied) {
      console.info(
        "[audio-startup] applied XVF3800 conversation tuning:",
        formatConfig(AUDIO_STARTUP_CONFIG),
      );
    } else {
      console.warn(
        "[audio-startup] daemon returned applied=false - " +
          "audio board may be unavailable on this platform.",
      );
    }
    return applied;
  } catch (err) {
    // Don't propagate: a missing audio board or a DataChannel hiccup
    // shouldn't kill the whole conversation startup. The Python
    // helper takes the same view (`return False` on any exception).
    console.warn(
      "[audio-startup] applyAudioConfig threw, continuing with daemon " +
        "defaults:",
      err,
    );
    return false;
  }
}

function formatConfig(config: readonly AudioStartupParameter[]): string {
  return config
    .map(
      ({ name, values }) =>
        `${name}=${values.map((v) => String(v)).join(" ")}`,
    )
    .join(", ");
}
