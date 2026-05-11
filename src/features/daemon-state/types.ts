/**
 * Shape of the daemon-state surface the rest of the app consumes.
 *
 * What lives here
 * ───────────────
 * Anything the daemon exposes via DataChannel commands AND that the
 * UI cares to mirror locally:
 *   - `speakerVolume` / `microphoneVolume` (read+write, debounced)
 *   - `daemonVersion`                       (read-only, fetched once)
 *
 * What does NOT live here
 * ───────────────────────
 *   - Robot poses streamed at 50 Hz (head, antennas, body_yaw): they
 *     belong on `RobotSessionHandle.engineState` / the SDK's
 *     `robotState` and would re-render every consumer of this
 *     context every animation frame, defeating the "shared state
 *     pool" purpose.
 *   - Pure UI prefs (theme, language, joystick sensitivity): not
 *     daemon-side. They'll get their own `user-prefs/` module the
 *     day they exist.
 *   - Logs: already covered by `daemon-logs/`.
 *
 * `null` discipline
 * ─────────────────
 * Each readable field starts at `null` and stays there until the
 * first successful fetch. Consumers should render a sensible
 * fallback (`50` for the slider thumb, "—" for the version chip)
 * during that window. The hook handles a single retry-on-null
 * internally so the stale `null` window is in the order of 250 ms
 * even when the DataChannel is slow to open.
 */

export interface DaemonStateValue {
  /** Speaker volume in [0, 100], or `null` until the first fetch
   *  lands. */
  speakerVolume: number | null;
  /** Microphone input volume in [0, 100], or `null` until the
   *  first fetch lands. */
  microphoneVolume: number | null;
  /** Daemon version string (e.g. `"1.7.1"`), or `null` when the
   *  data channel isn't open / the daemon predates the
   *  `get_version` Cmd. */
  daemonVersion: string | null;

  /**
   * Optimistic write: updates the local state immediately so the
   * slider tracks the finger, then debounces a DataChannel
   * round-trip 500 ms after the last call. The local state is
   * snapped to the daemon's *applied* value once the round-trip
   * resolves (which is usually the same number, but the daemon may
   * clamp). Audible chime feedback is played on success.
   */
  setSpeakerVolume: (value: number) => void;
  setMicrophoneVolume: (value: number) => void;

  /**
   * Mute toggles: write immediately (no debounce), mirroring the
   * desktop's "mute should land instantly" UX. Restoring from 0
   * uses the configured `unmuteRestoreValue` (default 50).
   */
  toggleSpeakerMute: () => void;
  toggleMicrophoneMute: () => void;
}
