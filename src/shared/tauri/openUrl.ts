import { openUrl as tauriOpenUrl } from '@tauri-apps/plugin-opener';

/**
 * Open a URL in the device's default browser.
 *
 * On iOS this hands off to the system UIApplication (Safari or the user's
 * default browser), on Android it fires an ACTION_VIEW Intent, and on
 * desktop it uses the same plugin as the desktop app.
 *
 * NOTE: this helper is NOT used for the HuggingFace OAuth sign-in flow
 * anymore. Apple App Review rejects flows that hand the user off to
 * Safari for sign-in, so OAuth now runs inside the app via
 * `ASWebAuthenticationSession` (see `src/features/auth/oauthLoopback.ts`).
 * Keep this helper for other non-auth use cases: opening a Space in the
 * system browser when the user explicitly chooses to leave the app,
 * surfacing support / docs links, etc.
 */
export async function openExternalUrl(url: string): Promise<void> {
  await tauriOpenUrl(url);
}
