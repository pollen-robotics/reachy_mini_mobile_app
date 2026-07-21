/**
 * Orb audio-reactivity controller.
 *
 * Wraps `MicLevelMonitor` + `AiLevelMonitor` (from `./audioLevelMonitor.ts`)
 * with the engine-side bookkeeping that used to live as a handful of
 * `let` variables and `start*` / `stop*` helpers inside
 * `conversation-engine.ts`:
 *
 *   - Lazy instantiation of each monitor on first `start*()` call
 *     (they're bound to a specific MediaStreamTrack and cheap to
 *     recreate per session).
 *   - Capture of the latest smoothed mic level in `[0..1]` so the
 *     React orb's microphone visualisation can read it from a rAF
 *     loop via `getMicLevel()` without re-rendering on every audio
 *     frame.
 *   - Forwarding of the host's user-supplied `onLevels` callback
 *     (untouched) for hosts that want the raw stream as well.
 *   - Pass-through to the AI monitor's `waitForSilence` /
 *     `cancelSilenceWait` so the engine can defer the transition
 *     out of `ai-speaking` until the actual voice tail has played
 *     out, not just until the backend says `response.done`.
 *   - `resumeAudio()` to wake the monitors' private AudioContexts
 *     after a visibility return (Safari / iOS aggressively suspend
 *     them in background tabs).
 *
 * The controller is stateless across sessions in the sense that the
 * monitors keep their instance and just rebind to new tracks; only
 * the cached `latestMicLevel` resets on `stopMic()`. The engine
 * never has to touch the monitor classes directly anymore.
 */

import { AiLevelMonitor, MicLevelMonitor } from "./audioLevelMonitor";
import type { ConversationLevelEvent } from "./types";

export interface AudioMonitorsControlDeps {
  /**
   * Lazy getter for the DOM element receiving the CSS custom
   * properties (`--audio-level`, `--bar0..--bar4`, `--ai-audio-level`).
   * Forwarded as-is to both monitors so a panel remount that swaps
   * the orb node is picked up on the next audio frame.
   */
  getTarget: () => HTMLElement | null;
  /**
   * Optional host-side observer for the raw level stream. The control
   * wraps it to also capture `latestMicLevel`; the wrapper forwards
   * untouched so hosts get every frame whether or not they care
   * about the cached value.
   */
  onLevels: ((level: ConversationLevelEvent) => void) | null;
}

export interface AudioMonitorsControl {
  /** Spawn / rebind the mic monitor on the given inbound robot mic
   *  track. Resets the cached `latestMicLevel` to 0 implicitly via
   *  the next frame's `onLevels`. */
  startMic: (track: MediaStreamTrack) => void;
  /** Stop the mic monitor without releasing the underlying class.
   *  Resets `latestMicLevel` to 0 so a stale frame doesn't bleed
   *  into a remounted visualiser before the next session's first
   *  callback lands. */
  stopMic: () => void;
  /** Spawn / rebind the AI monitor on the assistant output track. */
  startAi: (track: MediaStreamTrack) => void;
  /** Stop the AI monitor. Does NOT cancel any pending
   *  `waitForAiSilence` - callers that want to drop a queued
   *  callback should call `cancelAiSilenceWait()` themselves. */
  stopAi: () => void;
  /** Defer `cb` until the AI output has been quiet for `quietMs`.
   *  When no AI monitor has been started yet (e.g. the first
   *  response.done fires before the assistant track lands) the
   *  callback runs synchronously - the engine treats "no monitor"
   *  as "already silent" rather than dropping the transition. */
  waitForAiSilence: (quietMs: number, cb: () => void) => void;
  /** Drop any pending `waitForAiSilence` without firing the
   *  callback. Safe to call any time. */
  cancelAiSilenceWait: () => void;
  /** Wake both monitors' private AudioContexts after a visibility
   *  return. Safe to call when monitors haven't been started yet. */
  resumeAudio: () => void;
  /** Latest smoothed microphone level in `[0..1]`. Returns 0 when
   *  the mic monitor is stopped. */
  getMicLevel: () => number;
}

export function createAudioMonitorsControl(
  deps: AudioMonitorsControlDeps,
): AudioMonitorsControl {
  const { getTarget, onLevels: userOnLevels } = deps;

  let micMonitor: MicLevelMonitor | null = null;
  let aiMonitor: AiLevelMonitor | null = null;
  let latestMicLevel = 0;

  // Wrap the host's callback so we capture the mic side into the
  // local cache before forwarding. The same wrapper is shared by
  // both monitors; the AI side just falls through (only `level.user`
  // matters for the cache).
  const onLevels = (level: ConversationLevelEvent): void => {
    if (level.user !== null) {
      latestMicLevel = level.user;
    }
    if (userOnLevels) {
      try {
        userOnLevels(level);
      } catch (err) {
        console.warn("[audio-monitors] onLevels callback threw:", err);
      }
    }
  };

  return {
    startMic(track) {
      micMonitor ??= new MicLevelMonitor({ getTarget, onLevels });
      micMonitor.start(track);
    },
    stopMic() {
      micMonitor?.stop();
      latestMicLevel = 0;
    },
    startAi(track) {
      aiMonitor ??= new AiLevelMonitor({ getTarget, onLevels });
      aiMonitor.start(track);
    },
    stopAi() {
      aiMonitor?.stop();
    },
    waitForAiSilence(quietMs, cb) {
      if (!aiMonitor) {
        // No analyser yet means we have nothing to listen to; run
        // the callback inline so the caller's state transition
        // still happens. Mirrors the engine's pre-extraction
        // `if (aiLevel) { ... } else { ...synchronous... }` branch.
        cb();
        return;
      }
      aiMonitor.waitForSilence(quietMs, cb);
    },
    cancelAiSilenceWait() {
      aiMonitor?.cancelSilenceWait();
    },
    resumeAudio() {
      micMonitor?.resumeAudio();
      aiMonitor?.resumeAudio();
    },
    getMicLevel() {
      return latestMicLevel;
    },
  };
}
