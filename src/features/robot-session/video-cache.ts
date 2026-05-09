/**
 * Robot video stream cache.
 *
 * The SDK fires `videoTrack` exactly once per `startSession()` (and
 * once per `reacquireSession`). Consumers that mount AFTER that
 * one-shot event (e.g. the camera card on the Robot tab, gated on
 * `hasReachedReady`) would otherwise sit on a black frame forever
 * because the SDK's listener is freshly-registered and won't fire
 * again until the next session start.
 *
 * The cache breaks that race:
 *   - the engine wires a `videoTrack` listener at boot that calls
 *     `cache.set(stream)`;
 *   - on `sessionStopped` the engine calls `cache.clear()` so a
 *     late `attachVideo()` after a session ends never replays a
 *     dead track;
 *   - `attachVideo()` consumers always call `cache.replayInto(el)`
 *     after the SDK's own `attachVideo()` so they catch up to the
 *     current stream regardless of mount timing.
 *
 * Pure cache with no SDK coupling: takes / returns standard
 * `MediaStream` and `HTMLVideoElement`. The SDK's wireup lives in
 * the engine.
 */
export interface VideoStreamCache {
  /** Replace the cached stream. Called from the engine's
   *  `videoTrack` listener on every fresh session. */
  set: (stream: MediaStream) => void;
  /** Drop the cache. Called from the engine's `sessionStopped`
   *  listener so a stale stream from a dead session can't leak
   *  into the next attach. */
  clear: () => void;
  /** Read-only access to the latest cached stream. `null` until
   *  the first `videoTrack` of the current session fires. */
  get: () => MediaStream | null;
  /**
   * Replay the cached stream onto a freshly-attached video
   * element. No-op when the cache is empty or the element already
   * holds the same stream. Best-effort autoplay - swallows the
   * Safari "user hasn't interacted yet" rejection because the
   * upstream gesture (tapping the orb) usually satisfies it.
   */
  replayInto: (videoElement: HTMLVideoElement) => void;
}

export function createVideoStreamCache(): VideoStreamCache {
  let latest: MediaStream | null = null;

  const set = (stream: MediaStream): void => {
    latest = stream;
  };

  const clear = (): void => {
    latest = null;
  };

  const get = (): MediaStream | null => latest;

  const replayInto = (videoElement: HTMLVideoElement): void => {
    if (!latest) return;
    if (videoElement.srcObject === latest) return;
    videoElement.srcObject = latest;
    void videoElement.play().catch(() => {
      /* ignored - mostly defensive against Safari pre-gesture state */
    });
  };

  return { set, clear, get, replayInto };
}
