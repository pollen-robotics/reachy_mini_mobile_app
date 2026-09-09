/**
 * Android safe-area inset bridge (web half).
 *
 * Every safe-area token in the app resolves through
 * `var(--inset-*, env(safe-area-inset-*, 0px))` (see `ui/design/tokens.ts`).
 * iOS fills the `env()` fallback natively, but Android's WebView reports 0
 * for the system bars, so the host activity measures `WindowInsets` and hands
 * them over (the native half is written by `scripts/patch-android-insets.py`
 * into the generated MainActivity). Two channels:
 *
 *  - push (the reliable one): the activity re-evaluates
 *    `window.__reachyApplyInsets(...)` every 400ms until the handler defined
 *    below answers 'ok'. This is immune to load-order races: the activity's
 *    inset listener fires before the real document exists, and Android only
 *    exposes `addJavascriptInterface` objects to documents loaded after
 *    registration — wry may start loading before the activity gets the
 *    WebView — so no single-shot channel is safe on a cold start.
 *  - pull: `window.ReachyNativeInsets.get()`, answered from the activity's
 *    cache. Usually absent on the first document (see above) but instant on
 *    reloaded ones, where it beats the next push cycle.
 *
 * No-op on iOS / desktop / plain web (the bridge object never exists there).
 */

interface NativeInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

declare global {
  interface Window {
    /** Injected by the patched Android MainActivity via addJavascriptInterface. */
    ReachyNativeInsets?: { get(): string };
    /** Defined here; called by the Android host on every inset change. */
    __reachyApplyInsets?: (insets: NativeInsets) => void;
  }
}

function applyInsets(insets: NativeInsets): void {
  const style = document.documentElement.style;
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const value = insets[side];
    if (typeof value === 'number' && Number.isFinite(value)) {
      style.setProperty(`--inset-${side}`, `${Math.max(0, Math.round(value))}px`);
    }
  }
}

function pullOnce(): boolean {
  try {
    const raw = window.ReachyNativeInsets?.get();
    if (!raw) return false;
    applyInsets(JSON.parse(raw) as NativeInsets);
    return true;
  } catch (err) {
    console.warn('[android-insets] pull failed:', err);
    return false;
  }
}

export function installAndroidInsetsBridge(): void {
  window.__reachyApplyInsets = applyInsets;
  if (pullOnce()) return;
  // The interface object only appears on documents loaded after
  // `addJavascriptInterface` ran. `onWebViewCreate` fires before the first
  // load so in practice the first pull succeeds, but if an exotic ordering
  // ever loses that race a short retry window recovers instead of leaving
  // the bottom bar under the nav buttons for the whole session. Skipped
  // entirely off-Android, where the bridge will never appear.
  if (!/android/i.test(navigator.userAgent)) return;
  let tries = 0;
  const timer = window.setInterval(() => {
    if (pullOnce() || ++tries >= 20) window.clearInterval(timer);
  }, 250);
}
