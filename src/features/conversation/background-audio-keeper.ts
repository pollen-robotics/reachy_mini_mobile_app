/**
 * Keeps the iOS audio session "alive" while a conversation is
 * running, so the WebView is granted background time and the
 * WebRTC peer connection survives screen-off / app-backgrounded.
 *
 * Why this file exists
 * ────────────────────
 * iOS suspends WKWebView processes very aggressively when the host
 * app goes to background (within seconds). Suspended JS = dead
 * timers, dead AudioContexts, eventually dead WebRTC. The user's
 * conversation gets cut as soon as the iPhone screen turns off.
 *
 * The fix has two halves:
 *
 *   1. Native/plist: declare `UIBackgroundModes = ["audio"]` on the
 *      iOS bundle so iOS is willing to give us background time at
 *      all (see `src-tauri/Info.plist` + the iOS gen plist + the
 *      CI workflow patch).
 *   2. Runtime: while the conversation is active, keep an
 *      AudioContext continuously emitting audio to its
 *      `destination`. WKWebView sees that as "media is playing"
 *      and bumps the underlying `AVAudioSession` category to
 *      Playback (which is the category that, combined with the
 *      `audio` background mode, lets iOS keep us scheduled).
 *      Without this, even with the plist key set, the WebView
 *      defaults to `Ambient` category and gets suspended on
 *      background despite being "allowed" to keep running.
 *
 * The keeper does ONLY the runtime half. It's intentionally
 * decoupled from the realtime bridge / level monitors / wobbler so
 * those modules don't have to grow background-keepalive
 * responsibilities; they each own their own AudioContext for
 * analysis, while this one is the only one connected to
 * `destination`.
 *
 * Audio characteristics
 * ─────────────────────
 * The signal is a 30 Hz sine wave at -80 dBFS. Two design choices:
 *   - sub-audible frequency (30 Hz is below the typical iPhone
 *     speaker passband, you wouldn't hear it even at full
 *     volume) so we don't add a hum to the user's ears or to a
 *     paired BT headset.
 *   - non-zero amplitude (-80 dBFS) so WebKit's Web Audio engine
 *     doesn't optimise the chain away as a silent no-op. A pure
 *     0-amplitude path has been observed to be skipped at the
 *     graph compilation stage on some iOS WebKit builds, which
 *     defeats the whole point.
 *
 * Lifecycle
 * ─────────
 *   - `start()` is called by the conversation engine right after
 *     the realtime bridge connects (we have an active conv → we
 *     want background protection).
 *   - `stop()` is called from the same engine paths that tear
 *     down the bridge (stopConversation, full teardown, fatal
 *     error). Once stopped, iOS reverts the audio session to
 *     `Ambient` after a short grace and the app is back to
 *     normal foreground-only behaviour.
 *   - The keeper auto-resumes its AudioContext on
 *     `visibilitychange → visible` so a resume from a true OS
 *     suspension doesn't leave a dead silent context behind.
 */

export interface BackgroundAudioKeeper {
  /** Begin emitting the keepalive signal. Idempotent: a second
   *  call while already running is a no-op. */
  start(): void;
  /** Stop the keepalive signal and tear down the AudioContext. */
  stop(): void;
  /** Whether the keeper is currently running. */
  isRunning(): boolean;
}

/**
 * Sub-audible frequency. Picked below the iPhone speaker's
 * effective passband (~80 Hz - 14 kHz) so the signal is
 * mechanically silent on the speaker AND on most BT earbuds,
 * even though it's a real, non-zero waveform that WebKit's
 * Web Audio engine can't skip.
 */
const KEEPER_FREQ_HZ = 30;

/**
 * Linear gain corresponding to roughly -80 dBFS. Audible only
 * with serious gain in post (which never happens here - the
 * track is never mixed through anything other than the system
 * output). The point is to be non-zero, not to be loud.
 */
const KEEPER_GAIN_LINEAR = 1e-4;

export function createBackgroundAudioKeeper(): BackgroundAudioKeeper {
  let ctx: AudioContext | null = null;
  let oscillator: OscillatorNode | null = null;
  let gainNode: GainNode | null = null;
  let visibilityHandler: (() => void) | null = null;

  const start = (): void => {
    if (ctx) return;

    try {
      const audioCtx = new AudioContext();
      const osc = audioCtx.createOscillator();
      osc.frequency.value = KEEPER_FREQ_HZ;

      const gain = audioCtx.createGain();
      gain.gain.value = KEEPER_GAIN_LINEAR;

      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();

      ctx = audioCtx;
      oscillator = osc;
      gainNode = gain;
    } catch (err) {
      // AudioContext construction can fail if the user hasn't
      // gestured yet (pre-iOS 14 autoplay policy) or if the
      // device is in a weird audio state. We log and bail; the
      // conversation will still work foreground, just won't
      // survive a screen-off.
      console.warn(
        '[bg-audio-keeper] failed to start keepalive context. ' +
          'Background continuity disabled for this conversation.',
        err,
      );
      return;
    }

    // Auto-resume on visibility return: when iOS gives us back
    // CPU after a brief background trip, the AudioContext is
    // typically left in `suspended` state. Resuming it here
    // means motion + WebRTC pick back up immediately on the
    // first foreground frame instead of after the engine's
    // own visibilitychange wiring kicks in.
    visibilityHandler = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) return;
      ctx?.resume().catch((err) => {
        console.warn('[bg-audio-keeper] resume failed:', err);
      });
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', visibilityHandler);
    }
  };

  const stop = (): void => {
    if (visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityHandler);
    }
    visibilityHandler = null;

    try {
      oscillator?.stop();
      oscillator?.disconnect();
      gainNode?.disconnect();
      void ctx?.close();
    } catch {
      // Disconnect / close can throw if the nodes were already
      // garbage-collected (e.g. the page is unloading). Nothing
      // to do here, the references are dropped on the next line.
    }

    oscillator = null;
    gainNode = null;
    ctx = null;
  };

  const isRunning = (): boolean => ctx !== null;

  return { start, stop, isRunning };
}
