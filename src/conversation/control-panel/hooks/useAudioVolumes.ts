/**
 * Speaker + microphone volume state, scoped to the current
 * conversation session.
 *
 * Behaviour
 * ─────────
 *   1. On `enabled = true` (the panel becomes visible AND the
 *      session is far enough along that the DataChannel can
 *      round-trip), fetch the current speaker + mic volumes from
 *      the robot. They populate the local state.
 *   2. The slider is fully controlled: every drag tick calls
 *      `setSpeakerVolume(value)` synchronously on the local
 *      state (so the thumb tracks the finger), and schedules a
 *      debounced round-trip to the robot 500 ms after the last
 *      change.
 *   3. Mute toggle: bypasses debouncing and writes 0 / a "remember
 *      previous" value immediately, mirroring the desktop UX.
 *
 * Why a hook (not just inline state)
 * ──────────────────────────────────
 * The control panel is intentionally dumb. Encapsulating the
 * fetch / debounce / mute logic here lets the panel be a pure
 * layout component that can be lifted out of the conversation
 * view and dropped on a settings screen, or behind a debug menu,
 * without copy-pasting state plumbing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { RobotSessionHandle } from '../../../session/useRobotSession';

type VolumeMethods = Pick<
  RobotSessionHandle,
  | 'getSpeakerVolume'
  | 'setSpeakerVolume'
  | 'getMicrophoneVolume'
  | 'setMicrophoneVolume'
  | 'playSound'
>;

/**
 * Sound played by the daemon as audible feedback when the user
 * settles on a new volume (speaker OR mic). Short file
 * (`count.wav`, ~660 ms) so the feedback feels snappy:
 *
 *   - On a SPEAKER change, the user hears the chime at the new
 *     speaker level - immediate ear-level test.
 *   - On a MICROPHONE change, the user hears the chime as a
 *     "command received" ack: changing the mic gain itself
 *     doesn't produce audio, so the chime confirms the daemon
 *     accepted the new value for the next utterance.
 *
 * Same file for both keeps the feedback feel consistent across
 * the two sliders.
 */
const FEEDBACK_SOUND = 'count.wav';

interface UseAudioVolumesOptions {
  session: VolumeMethods;
  /**
   * When false the hook stays idle (no fetches, no debounce timer
   * running). The host should set this to true only once the
   * session is stable enough for a round-trip - typically once
   * the engine has reached `ready` for the first time.
   */
  enabled: boolean;
  /**
   * Volume to "unmute back to" when the user toggles the mute
   * button while the slider is at 0. Defaults to 50 to match the
   * desktop's "always come back to a sensible level" UX.
   */
  unmuteRestoreValue?: number;
  /**
   * Round-trip debounce in milliseconds. Defaults to 500 ms,
   * same as the desktop. Lower = more network chatter, higher =
   * the user feels lag.
   */
  debounceMs?: number;
}

export interface UseAudioVolumesResult {
  /** Speaker volume in [0, 100]. Defaults to 50 until the first
   *  fetch lands. */
  speakerVolume: number;
  /** Microphone input volume in [0, 100]. */
  microphoneVolume: number;
  /** Optimistically updates the slider AND debounces a write. */
  setSpeakerVolume: (value: number) => void;
  setMicrophoneVolume: (value: number) => void;
  /** Toggle mute (immediate write, bypasses the debounce). */
  toggleSpeakerMute: () => void;
  toggleMicrophoneMute: () => void;
}

const DEFAULT_VOLUME = 50;
const DEFAULT_UNMUTE_VALUE = 50;
const DEFAULT_DEBOUNCE_MS = 500;

export function useAudioVolumes({
  session,
  enabled,
  unmuteRestoreValue = DEFAULT_UNMUTE_VALUE,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: UseAudioVolumesOptions): UseAudioVolumesResult {
  const [speakerVolume, setSpeakerVolumeState] = useState(DEFAULT_VOLUME);
  const [microphoneVolume, setMicrophoneVolumeState] = useState(DEFAULT_VOLUME);

  // Refs to the latest session methods. Used by the debounced
  // writers so we don't have to re-create the callbacks (and
  // re-arm the debounce) every time the session handle's identity
  // changes - which it does on every state update from the engine.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const speakerDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial fetch when we become enabled. Does nothing if the
  // session isn't ready - the volume calls return null silently
  // and the local state stays at `DEFAULT_VOLUME`. The host can
  // re-enable us later (e.g. after a release / reacquire) and
  // we'll re-fetch then.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const [spk, mic] = await Promise.all([
        sessionRef.current.getSpeakerVolume(),
        sessionRef.current.getMicrophoneVolume(),
      ]);
      if (cancelled) return;
      if (typeof spk === 'number') setSpeakerVolumeState(spk);
      if (typeof mic === 'number') setMicrophoneVolumeState(mic);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // Cleanup any pending debounced writes when the host unmounts
  // us (or `enabled` flips back off). Avoids a write firing
  // against a torn-down session.
  useEffect(() => {
    return () => {
      if (speakerDebounceRef.current) {
        clearTimeout(speakerDebounceRef.current);
        speakerDebounceRef.current = null;
      }
      if (micDebounceRef.current) {
        clearTimeout(micDebounceRef.current);
        micDebounceRef.current = null;
      }
    };
  }, []);

  /**
   * Optimistic local update + debounced network write. The
   * session's setter is non-throwing (returns null on failure),
   * so we don't bother revertiing the local state - the slider
   * stays where the user left it and the next initial-fetch
   * (e.g. after re-enable) snaps it to the truth.
   */
  const setSpeakerVolume = useCallback(
    (value: number): void => {
      setSpeakerVolumeState(value);
      if (speakerDebounceRef.current) {
        clearTimeout(speakerDebounceRef.current);
      }
      speakerDebounceRef.current = setTimeout(() => {
        speakerDebounceRef.current = null;
        // Audible feedback: once the new speaker volume has
        // been *applied* by the daemon, ask the daemon to play
        // a short sound through the speaker so the user can
        // immediately hear the new level. Skipped when the
        // user just dropped the volume to 0 - we'd play a
        // sound the user can't hear.
        void sessionRef.current.setSpeakerVolume(value).then(applied => {
          if (applied !== null && applied > 0) {
            sessionRef.current.playSound(FEEDBACK_SOUND);
          }
        });
      }, debounceMs);
    },
    [debounceMs],
  );

  const setMicrophoneVolume = useCallback(
    (value: number): void => {
      setMicrophoneVolumeState(value);
      if (micDebounceRef.current) {
        clearTimeout(micDebounceRef.current);
      }
      micDebounceRef.current = setTimeout(() => {
        micDebounceRef.current = null;
        // Same audible-ack pattern as the speaker side: chime
        // once the daemon confirms the new value. The chime
        // plays through the *speaker* (mic gain doesn't make
        // the robot produce sound), but it's still useful as
        // a "your change landed" cue. Skipped on mute (value
        // 0) - the action's intent IS silence.
        void sessionRef.current.setMicrophoneVolume(value).then(applied => {
          if (applied !== null && applied > 0) {
            sessionRef.current.playSound(FEEDBACK_SOUND);
          }
        });
      }, debounceMs);
    },
    [debounceMs],
  );

  /**
   * Mute toggle: writes immediately (no debounce). Mirrors the
   * desktop's snappy mute UX - the user expects mute to "land"
   * the instant they tap, not 500 ms later.
   */
  const toggleSpeakerMute = useCallback((): void => {
    const next = speakerVolume > 0 ? 0 : unmuteRestoreValue;
    if (speakerDebounceRef.current) {
      clearTimeout(speakerDebounceRef.current);
      speakerDebounceRef.current = null;
    }
    setSpeakerVolumeState(next);
    void sessionRef.current.setSpeakerVolume(next).then(applied => {
      // Only chirp on UNMUTE (next > 0). Muting and then
      // playing a sound through the (now-zero) speaker would
      // be silent anyway, plus users expect mute to be
      // *quiet*, not "now I'm quiet, but here's a sound".
      if (applied !== null && applied > 0) {
        sessionRef.current.playSound(FEEDBACK_SOUND);
      }
    });
  }, [speakerVolume, unmuteRestoreValue]);

  const toggleMicrophoneMute = useCallback((): void => {
    const next = microphoneVolume > 0 ? 0 : unmuteRestoreValue;
    if (micDebounceRef.current) {
      clearTimeout(micDebounceRef.current);
      micDebounceRef.current = null;
    }
    setMicrophoneVolumeState(next);
    void sessionRef.current.setMicrophoneVolume(next).then(applied => {
      if (applied !== null && applied > 0) {
        sessionRef.current.playSound(FEEDBACK_SOUND);
      }
    });
  }, [microphoneVolume, unmuteRestoreValue]);

  return {
    speakerVolume,
    microphoneVolume,
    setSpeakerVolume,
    setMicrophoneVolume,
    toggleSpeakerMute,
    toggleMicrophoneMute,
  };
}
