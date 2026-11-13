/**
 * Hardware volume-key bridge (web half).
 *
 * Only Android can intercept the phone's volume buttons: the patched
 * MainActivity (`scripts/patch-android-insets.py`) swallows
 * VOLUME_UP / VOLUME_DOWN while the page has opted in, and forwards them
 * through `window.__reachyVolumeKey(+1 | -1)`. iOS exposes no key event to
 * apps (only an `outputVolume` observer on the phone's own volume), so there
 * this is a no-op and the keys keep driving the phone volume.
 *
 * Opt-in is refcount-free and explicit: `subscribeVolumeKeys` enables the
 * native interception, the returned cleanup disables it again so the keys
 * go back to the system the moment the robot is no longer controlled.
 */

export type VolumeKeyDirection = 1 | -1;

declare global {
  interface Window {
    /** Injected by the patched Android MainActivity via addJavascriptInterface. */
    ReachyNativeVolume?: { setEnabled(enabled: boolean): void };
    /** Defined while subscribed; called by the Android host on each key press. */
    __reachyVolumeKey?: (direction: number) => void;
  }
}

/** Clamp to the daemon's 0-100 volume range and round to an integer. */
export function clampVolume(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function setNativeEnabled(enabled: boolean): void {
  try {
    window.ReachyNativeVolume?.setEnabled(enabled);
  } catch (err) {
    console.warn('[volume-keys] setEnabled failed:', err);
  }
}

/**
 * Start receiving hardware volume key presses. Returns the cleanup that
 * hands the keys back to the system. Safe to call on any platform.
 */
export function subscribeVolumeKeys(
  onKey: (direction: VolumeKeyDirection) => void,
): () => void {
  const handler = (direction: number): void => {
    if (direction === 1 || direction === -1) onKey(direction);
  };
  window.__reachyVolumeKey = handler;
  setNativeEnabled(true);

  // The interface only exists on documents loaded after the activity
  // registered it (same constraint as the insets bridge): retry briefly
  // instead of silently leaving the keys on the phone volume.
  let timer: number | undefined;
  if (!window.ReachyNativeVolume && /android/i.test(navigator.userAgent)) {
    let tries = 0;
    timer = window.setInterval(() => {
      if (window.ReachyNativeVolume || ++tries >= 20) {
        window.clearInterval(timer);
        timer = undefined;
        setNativeEnabled(true);
      }
    }, 250);
  }

  return () => {
    if (timer !== undefined) window.clearInterval(timer);
    // A newer subscriber may already own the keys: an outgoing session
    // screen unmounts after the incoming one mounted during a screen
    // transition. Its cleanup must then leave both the handler and the
    // native interception alone.
    if (window.__reachyVolumeKey !== handler) return;
    delete window.__reachyVolumeKey;
    setNativeEnabled(false);
  };
}
