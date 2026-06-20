import { openUrl as tauriOpenUrl } from '@tauri-apps/plugin-opener';
import { getPlatform } from '@/shared/platform';

/**
 * Open a URL in the device's default browser.
 *
 * On iOS this hands off to the system UIApplication (Safari or the user's
 * default browser), on Android it fires an ACTION_VIEW Intent, and on
 * desktop it uses the same plugin as the desktop app.
 *
 * Web-dev fallback
 * ────────────────
 * `tauriOpenUrl` calls into `window.__TAURI_INTERNALS__.invoke`, which is
 * only injected by the Tauri runtime. In a plain browser (`yarn dev` /
 * `npm run dev` opened in Chrome, future PWA fallback, browser-based
 * Storybook), that object is `undefined` and the plugin throws
 * `Cannot read properties of undefined (reading 'invoke')`. Detect that
 * case up-front and fall back to `window.open`, so consent / help /
 * docs links keep working while we develop without firing up a full
 * Tauri rebuild for every copy tweak.
 *
 * NOTE: this helper is NOT used for the HuggingFace OAuth sign-in flow
 * anymore. Apple App Review rejects flows that hand the user off to
 * Safari for sign-in, so OAuth now runs inside the app via
 * `ASWebAuthenticationSession` (see `src/features/auth/oauthLoopback.ts`).
 * Keep this helper for other non-auth use cases: opening a Space in the
 * system browser when the user explicitly chooses to leave the app,
 * surfacing support / docs links, etc.
 */
function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriRuntime()) {
    await tauriOpenUrl(url);
    return;
  }
  // Browser fallback. `noopener,noreferrer` so the new tab cannot
  // navigate this one via `window.opener`, matching the security
  // posture of the Tauri-side flow.
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Best-effort deep-link to the OS settings screen where the user can flip
 * a permission they previously denied (e.g. Bluetooth after a hard "Don't
 * allow").
 *
 * - iOS: `app-settings:` is routed by `UIApplication.open` straight to
 *   this app's Settings pane.
 * - Android: there is no stable URL scheme for the per-app settings
 *   screen (it needs an `ACTION_APPLICATION_DETAILS_SETTINGS` intent the
 *   opener plugin can't fire), so we no-op and rely on in-UI copy that
 *   walks the user to Settings › Apps › Reachy Mini › Permissions.
 *
 * Returns `true` when a settings page was actually opened, so callers can
 * tailor their copy / button layout.
 */
export async function openAppSettings(): Promise<boolean> {
  if (getPlatform() === 'ios') {
    try {
      await openExternalUrl('app-settings:');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
