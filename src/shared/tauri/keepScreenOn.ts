/**
 * Keep-screen-on wrapper.
 *
 * The host has TWO complementary mechanisms that prevent the device
 * from auto-locking the screen:
 *
 * 1. **Tauri native plugin (`tauri-plugin-keep-screen-on`)**. Wraps
 *    `UIApplication.isIdleTimerDisabled` on iOS and
 *    `FLAG_KEEP_SCREEN_ON` on Android. This is the only path that
 *    works inside an `https://tauri.localhost` WKWebView - the Web
 *    Wake Lock API is NOT exposed by mobile WebViews. The plugin
 *    compiles to a no-op on desktop targets so calling it
 *    unconditionally is safe.
 *
 * 2. **Web Wake Lock API (`navigator.wakeLock`)**. Works in
 *    macOS WKWebView, Linux WebKitGTK, and modern desktop browsers.
 *    Provides keep-awake during desktop preview builds where the
 *    Tauri plugin is a stub.
 *
 * We call both. They're idempotent at the OS level and never fight
 * each other - the one that actually has effect on the current
 * platform wins.
 *
 * Refcounted (`acquire()` / `release()` pair semantics) so multiple
 * React subtrees can request keep-awake concurrently without
 * stepping on each other. The screen is allowed to dim again only
 * once every caller has released its claim.
 *
 * Why this is NOT a class
 * ───────────────────────
 * Module-level state is intentional: we need a single refcount
 * shared across every consumer in the React tree. A class instance
 * would let two components instantiate their own counter and
 * either over-acquire (battery waste) or release prematurely
 * (broken UX).
 */

import { keepScreenOn as tauriKeepScreenOn } from 'tauri-plugin-keep-screen-on-api';

/**
 * Subset of the Wake Lock API we actually call. Defined locally
 * because the property is genuinely optional at runtime (older
 * browsers and every mobile WebView don't ship it).
 */
interface MaybeWakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinel>;
}
interface WakeLockSentinel {
  release(): Promise<void>;
}

let refCount = 0;
let webSentinel: WakeLockSentinel | null = null;
/** Latched once the Web API has denied us once: stop spamming on
 * every re-acquire. The native plugin keeps trying because it has
 * its own success/failure semantics per call (cheap). */
let webUnavailable = false;

/**
 * Increment the refcount by one and (if this is the first claim)
 * enable keep-screen-on. Safe to call from any React effect.
 *
 * The returned promise resolves when both native + web paths have
 * settled; callers can `void`-await it.
 */
export async function acquireKeepScreenOn(): Promise<void> {
  refCount += 1;
  if (refCount === 1) {
    await Promise.all([enableNative(), enableWeb()]);
  }
}

/**
 * Decrement the refcount by one. Once the count hits zero we
 * release every backing mechanism so the system idle timer
 * resumes its normal behaviour.
 *
 * No-op if called more times than `acquireKeepScreenOn()`. We
 * clamp to zero defensively so a stray double-release doesn't
 * desync the counter.
 */
export async function releaseKeepScreenOn(): Promise<void> {
  if (refCount === 0) return;
  refCount -= 1;
  if (refCount === 0) {
    await Promise.all([disableNative(), disableWeb()]);
  }
}

async function enableNative(): Promise<void> {
  try {
    await tauriKeepScreenOn(true);
  } catch (err) {
    // Plugin not registered (pure-Vite dev), or platform refused
    // the call. The Web fallback covers desktop preview; on iOS /
    // Android this is a real signal that something is wrong, but
    // we shouldn't crash the UI over it.
    console.warn('[keep-screen-on] native enable failed:', err);
  }
}

async function disableNative(): Promise<void> {
  try {
    await tauriKeepScreenOn(false);
  } catch (err) {
    console.warn('[keep-screen-on] native disable failed:', err);
  }
}

async function enableWeb(): Promise<void> {
  if (webUnavailable) return;
  if (webSentinel) return;
  const nav = navigator as Navigator & { wakeLock?: MaybeWakeLockApi };
  if (!nav.wakeLock) {
    webUnavailable = true;
    return;
  }
  try {
    webSentinel = await nav.wakeLock.request('screen');
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      webUnavailable = true;
    } else {
      console.warn('[keep-screen-on] wakeLock.request failed:', err);
    }
    webSentinel = null;
  }
}

async function disableWeb(): Promise<void> {
  try {
    await webSentinel?.release();
  } catch {
    // ignored
  }
  webSentinel = null;
}
