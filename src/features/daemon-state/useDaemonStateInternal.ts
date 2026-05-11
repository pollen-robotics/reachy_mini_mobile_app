/**
 * Internal hook backing `<DaemonStateProvider>`.
 *
 * Single source of truth for "what the daemon thinks the volumes /
 * version are right now, mirrored locally". Should never be used
 * directly outside the provider - consumers go through
 * `useDaemonState()`, which short-circuits on missing context.
 *
 * Lifecycle
 * ─────────
 * Mounts whenever the host hands us a session handle. The actual
 * fetches are gated on `enabled`: the host should pass
 * `session.hasReachedReady` here (true once the engine has reached
 * `ready` for the first time on the current session).
 *
 *   - On `enabled` flipping true:
 *       1. Reset state to a fresh `null` triple (sliders fall back
 *          to their "no daemon answer yet" default of 50).
 *       2. Kick off three parallel `get_*` round-trips.
 *       3. For each one that comes back `null` (DC was not open
 *          yet at the time of the call), schedule a single retry
 *          250 ms later. We don't loop forever - if the second try
 *          also fails, we leave the state at `null` and let the
 *          consumer fall back. Most of the time the DC opens
 *          within ~150 ms of `hasReachedReady`, so a 250 ms wait +
 *          one retry is enough to bridge the gap without giving up
 *          permanently.
 *   - On `enabled` flipping false: clear the state, cancel any
 *     in-flight retry, drop pending debounced writes (they would
 *     fire against a torn-down session).
 *
 * Why no automatic refresh on release/reacquire
 * ─────────────────────────────────────────────
 * `enabled` mirrors `hasReachedReady`, which is sticky across a
 * release/reacquire cycle (by design - the host doesn't want to
 * replay the connecting overlay every time the user opens an iframe
 * app). So we don't get a flip-true edge to re-fetch on. In
 * practice this is fine: the daemon-side values (volume, version)
 * only change in response to commands WE sent, so our local mirror
 * stays accurate. If a future feature ever lets a third party
 * mutate the daemon's volume out-of-band, we'll add a `refresh()`
 * exit and call it on the reacquire path.
 *
 * Why this hook is internal
 * ─────────────────────────
 * Two reasons:
 *   1. Mounting it in two places would defeat the whole purpose
 *      (two parallel fetches + two parallel debounces). The
 *      provider enforces single-instance.
 *   2. The consumer-facing hook (`useDaemonState`) returns the
 *      `DaemonStateValue` shape from `types.ts`, which is the
 *      stable public contract. The fact that we implement it
 *      with `useState` + `useEffect` + `useRef` is an internal
 *      detail; if we ever swap to Zustand / React Query, the
 *      consumer surface stays unchanged.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { RobotSessionHandle } from "@/features/robot-session/useRobotSession";

import type { DaemonStateValue } from "./types";

/** Methods on the session handle that this hook actually calls. */
export type DaemonStateSessionMethods = Pick<
  RobotSessionHandle,
  | "getSpeakerVolume"
  | "setSpeakerVolume"
  | "getMicrophoneVolume"
  | "setMicrophoneVolume"
  | "getDaemonVersion"
  | "playSound"
>;

interface UseDaemonStateInternalOptions {
  session: DaemonStateSessionMethods;
  enabled: boolean;
  /**
   * Volume to "unmute back to" when the user toggles the mute
   * button while the slider is at 0. Defaults to 50 to match the
   * desktop's "always come back to a sensible level" UX.
   */
  unmuteRestoreValue?: number;
  /**
   * Round-trip debounce for the volume sliders, in milliseconds.
   * 500 ms is the desktop default and the right balance between
   * "slider feels responsive" and "we don't spam the DataChannel
   * during a long drag".
   */
  debounceMs?: number;
}

const DEFAULT_UNMUTE_VALUE = 50;
const DEFAULT_DEBOUNCE_MS = 500;
const RETRY_AFTER_MS = 250;

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
const FEEDBACK_SOUND = "count.wav";

export function useDaemonStateInternal({
  session,
  enabled,
  unmuteRestoreValue = DEFAULT_UNMUTE_VALUE,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: UseDaemonStateInternalOptions): DaemonStateValue {
  const [speakerVolume, setSpeakerVolumeState] = useState<number | null>(null);
  const [microphoneVolume, setMicrophoneVolumeState] = useState<number | null>(null);
  const [daemonVersion, setDaemonVersion] = useState<string | null>(null);

  // Latest session handle, kept on a ref so the debounced writers
  // and retry timers don't have to be re-armed every time the
  // session reference changes (which it does on every engine
  // re-render). The setters take their session from `sessionRef.current`
  // at call time; this is safe because the host guarantees the
  // session is still alive while `enabled` is true.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // Pending debounced writes. Cleared on disable + on unmount so
  // we never fire against a torn-down session.
  const speakerDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pending retry-on-null timers. Each fetch can schedule at most
  // one retry, after which we give up and leave the state at `null`.
  const speakerRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const versionRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAllTimers = useCallback(() => {
    for (const ref of [
      speakerDebounceRef,
      micDebounceRef,
      speakerRetryRef,
      micRetryRef,
      versionRetryRef,
    ]) {
      if (ref.current) {
        clearTimeout(ref.current);
        ref.current = null;
      }
    }
  }, []);

  // Initial fetch + retry-on-null on every enable transition.
  useEffect(() => {
    if (!enabled) {
      clearAllTimers();
      setSpeakerVolumeState(null);
      setMicrophoneVolumeState(null);
      setDaemonVersion(null);
      return undefined;
    }

    // Fresh snapshot: reset to nulls so a stale value from a
    // previous session can't briefly flash through.
    setSpeakerVolumeState(null);
    setMicrophoneVolumeState(null);
    setDaemonVersion(null);

    let cancelled = false;

    const tryFetchSpeaker = async (isRetry: boolean): Promise<void> => {
      const v = await sessionRef.current.getSpeakerVolume();
      if (cancelled) return;
      if (typeof v === "number") {
        setSpeakerVolumeState(v);
        return;
      }
      if (!isRetry) {
        speakerRetryRef.current = setTimeout(() => {
          speakerRetryRef.current = null;
          void tryFetchSpeaker(true);
        }, RETRY_AFTER_MS);
      }
    };

    const tryFetchMic = async (isRetry: boolean): Promise<void> => {
      const v = await sessionRef.current.getMicrophoneVolume();
      if (cancelled) return;
      if (typeof v === "number") {
        setMicrophoneVolumeState(v);
        return;
      }
      if (!isRetry) {
        micRetryRef.current = setTimeout(() => {
          micRetryRef.current = null;
          void tryFetchMic(true);
        }, RETRY_AFTER_MS);
      }
    };

    const tryFetchVersion = async (isRetry: boolean): Promise<void> => {
      const v = await sessionRef.current.getDaemonVersion();
      if (cancelled) return;
      if (typeof v === "string" && v.length > 0) {
        setDaemonVersion(v);
        return;
      }
      if (!isRetry) {
        versionRetryRef.current = setTimeout(() => {
          versionRetryRef.current = null;
          void tryFetchVersion(true);
        }, RETRY_AFTER_MS);
      }
    };

    void tryFetchSpeaker(false);
    void tryFetchMic(false);
    void tryFetchVersion(false);

    return () => {
      cancelled = true;
      clearAllTimers();
    };
  }, [enabled, clearAllTimers]);

  // Cleanup any pending writes on unmount.
  useEffect(() => clearAllTimers, [clearAllTimers]);

  const setSpeakerVolume = useCallback(
    (value: number): void => {
      setSpeakerVolumeState(value);
      if (speakerDebounceRef.current) clearTimeout(speakerDebounceRef.current);
      speakerDebounceRef.current = setTimeout(() => {
        speakerDebounceRef.current = null;
        void sessionRef.current.setSpeakerVolume(value).then((applied) => {
          // Snap to the daemon's authoritative value (usually
          // identical, but it may clamp). Skipped on null which
          // means the DC dropped; we keep the optimistic value
          // so the slider doesn't jerk back unexpectedly.
          if (typeof applied === "number") {
            setSpeakerVolumeState(applied);
            // Audible feedback at the new speaker level. Skip when
            // the user just dropped to 0 - playing a sound the user
            // can't hear is pointless and silly.
            if (applied > 0) sessionRef.current.playSound(FEEDBACK_SOUND);
          }
        });
      }, debounceMs);
    },
    [debounceMs],
  );

  const setMicrophoneVolume = useCallback(
    (value: number): void => {
      setMicrophoneVolumeState(value);
      if (micDebounceRef.current) clearTimeout(micDebounceRef.current);
      micDebounceRef.current = setTimeout(() => {
        micDebounceRef.current = null;
        void sessionRef.current.setMicrophoneVolume(value).then((applied) => {
          if (typeof applied === "number") {
            setMicrophoneVolumeState(applied);
            // Same audible-ack pattern as the speaker side: chime
            // through the speaker on success. Mic gain doesn't
            // make the robot produce sound, but the chime is still
            // useful as a "your change landed" cue. Skipped on
            // mute (value 0) - the user's intent IS silence.
            if (applied > 0) sessionRef.current.playSound(FEEDBACK_SOUND);
          }
        });
      }, debounceMs);
    },
    [debounceMs],
  );

  const toggleSpeakerMute = useCallback((): void => {
    const current = speakerVolume ?? 0;
    const next = current > 0 ? 0 : unmuteRestoreValue;
    if (speakerDebounceRef.current) {
      clearTimeout(speakerDebounceRef.current);
      speakerDebounceRef.current = null;
    }
    setSpeakerVolumeState(next);
    void sessionRef.current.setSpeakerVolume(next).then((applied) => {
      if (typeof applied === "number") {
        setSpeakerVolumeState(applied);
        // Only chirp on UNMUTE (next > 0). Muting AND playing a
        // sound through the (now-zero) speaker would be silent
        // anyway; users expect mute to be quiet, not "now I'm
        // quiet, but here's a sound".
        if (applied > 0) sessionRef.current.playSound(FEEDBACK_SOUND);
      }
    });
  }, [speakerVolume, unmuteRestoreValue]);

  const toggleMicrophoneMute = useCallback((): void => {
    const current = microphoneVolume ?? 0;
    const next = current > 0 ? 0 : unmuteRestoreValue;
    if (micDebounceRef.current) {
      clearTimeout(micDebounceRef.current);
      micDebounceRef.current = null;
    }
    setMicrophoneVolumeState(next);
    void sessionRef.current.setMicrophoneVolume(next).then((applied) => {
      if (typeof applied === "number") {
        setMicrophoneVolumeState(applied);
        if (applied > 0) sessionRef.current.playSound(FEEDBACK_SOUND);
      }
    });
  }, [microphoneVolume, unmuteRestoreValue]);

  return {
    speakerVolume,
    microphoneVolume,
    daemonVersion,
    setSpeakerVolume,
    setMicrophoneVolume,
    toggleSpeakerMute,
    toggleMicrophoneMute,
  };
}
