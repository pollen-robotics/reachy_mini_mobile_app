/**
 * Background-tab + page-hide resilience.
 *
 * Two distinct browser hazards live behind one tiny listener pack:
 *
 * 1. **Tab going hidden / coming back**  
 *    Browsers throttle JS timers and may suspend AudioContexts in
 *    hidden tabs. The native WebRTC media stack keeps running, but
 *    any analyser / interval-based work the engine relies on can
 *    stall. We notify the engine on visibility return so it can
 *    re-acquire its wake lock, resume its audio contexts, and probe
 *    the robot data channel.
 *
 * 2. **Page being killed mid-session**  
 *    iOS Safari's bfcache eviction, hard reload, native back nav,
 *    `tauri:dev` restart, app swiped away on iOS… any of these can
 *    drop the page without React running `unmount()`. We fire a
 *    `navigator.sendBeacon` to central with `{type: 'endSession'}`
 *    so the robot doesn't stay locked as "busy" for the next launch,
 *    plus a best-effort `robot.disconnect()` for the local PC.
 *
 *    `pagehide` is preferred over `beforeunload` because the latter
 *    is unreliable on mobile, but we register both for safety. We
 *    use `sendBeacon` over `fetch` because it's the only documented
 *    way to keep a request alive past the page going away on iOS
 *    WebView.
 */

import type { ReachyMiniInstance } from "./sdk-types";

export interface BackgroundResilienceDeps {
  /**
   * Fires when the tab returns to focus. The engine decides what to
   * do (re-acquire wake lock, resume audio contexts, probe the
   * robot data channel, …) - typically it gates on whether a
   * conversation is currently live.
   */
  onResume: () => void;

  /**
   * Live SDK instance accessor. Used for the beacon path to read the
   * session id off the robot, and to call `disconnect()` as a
   * fallback. `null` means there's no session to clean up; both
   * code paths are no-ops in that case.
   */
  getRobot: () => ReachyMiniInstance | null;

  /**
   * `https://<central-host>/send` URL the SDK uses for signaling.
   * The beacon hits the same endpoint with a `?token=` query
   * because we can't set Authorization headers from `sendBeacon`.
   */
  centralSendUrl: string;
}

/**
 * Install all the listeners (`visibilitychange`, `pagehide`,
 * `beforeunload`). Returns a disposer the engine MUST call from its
 * `unmount()` so a fast remount doesn't double-register.
 */
export function installBackgroundResilience(
  deps: BackgroundResilienceDeps,
): () => void {
  const onVisibilityChange = (): void => {
    if (document.hidden) return;
    deps.onResume();
  };

  const onPageHide = (): void => {
    sendEndSessionBeacon(deps);
    // Standard SDK disconnect path: tears down the local PC and (in
    // healthy conditions) also POSTs `endSession` via fetch. The
    // beacon above is the belt; this is the suspenders.
    try {
      deps.getRobot()?.disconnect();
    } catch {
      // best-effort only; the page is going away
    }
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("beforeunload", onPageHide);

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("beforeunload", onPageHide);
  };
}

function sendEndSessionBeacon(deps: BackgroundResilienceDeps): void {
  try {
    type RobotInternals = {
      _sessionId?: string | null;
      username?: string | null;
    };
    const internals = deps.getRobot() as unknown as RobotInternals | null;
    const sessionId = internals?._sessionId ?? null;
    const token =
      typeof sessionStorage !== "undefined"
        ? sessionStorage.getItem("hf_token")
        : null;
    if (
      sessionId &&
      token &&
      typeof navigator !== "undefined" &&
      navigator.sendBeacon
    ) {
      const url = `${deps.centralSendUrl}?token=${encodeURIComponent(token)}`;
      const payload = JSON.stringify({ type: "endSession", sessionId });
      const blob = new Blob([payload], { type: "application/json" });
      navigator.sendBeacon(url, blob);
    }
  } catch {
    // best-effort only
  }
}
