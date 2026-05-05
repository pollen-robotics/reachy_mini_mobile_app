/**
 * Screen Wake Lock + AudioContext resume helpers.
 *
 * Browsers throttle JS timers and may suspend AudioContexts in hidden
 * tabs. The WebRTC media stack itself is native and keeps running, so
 * voice keeps flowing - but our VAD / wobbler / mic-level analysers
 * stop updating, AudioContexts can end up suspended on return
 * (Safari, mobile), and a device sleep during silence can kill
 * everything.
 *
 * `WakeLockHandle` owns the Wake Lock sentinel for the duration of a
 * session and degrades cleanly when the browser denies the request
 * (HF Spaces iframes don't allow `screen-wake-lock` by default - we
 * remember and stop spamming on every visibilitychange).
 */

/**
 * Subset of the Wake Lock API we actually call. Defined locally
 * rather than relying on `Navigator.wakeLock` from `lib.dom.d.ts`
 * because that type was added in a later TS lib than our build
 * targets - and the property is genuinely optional at runtime
 * (older browsers don't ship it).
 */
interface MaybeWakeLock {
  request(type: 'screen'): Promise<{ release(): Promise<void> }>;
}

export class WakeLockHandle {
  private sentinel: { release(): Promise<void> } | null = null;
  /** Latched once the browser has denied the request: subsequent
   * calls to `acquire()` return immediately so we don't spam. */
  private unavailable = false;

  async acquire(): Promise<void> {
    if (this.unavailable) return;
    const nav = navigator as Navigator & { wakeLock?: MaybeWakeLock };
    if (!nav.wakeLock) {
      this.unavailable = true;
      return;
    }
    if (this.sentinel) return;
    try {
      this.sentinel = await nav.wakeLock.request('screen');
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.unavailable = true;
        console.info(
          '[main] Screen Wake Lock unavailable (permissions policy). Continuing without it.',
        );
      } else {
        console.warn('[main] wakeLock.request failed:', err);
      }
      this.sentinel = null;
    }
  }

  async release(): Promise<void> {
    try {
      await this.sentinel?.release();
    } catch {
      // ignored
    }
    this.sentinel = null;
  }
}
