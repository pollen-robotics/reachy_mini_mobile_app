import { openUrl as tauriOpenUrl } from '@tauri-apps/plugin-opener';

/**
 * Open a URL in the device's default browser.
 *
 * On iOS this hands off to the system UIApplication (Safari or the user's
 * default browser), on Android it fires an ACTION_VIEW Intent, and on
 * desktop it uses the same plugin as the desktop app.
 *
 * We always go through the system browser for HuggingFace-hosted pages
 * because:
 *   * `huggingface.co/login` sets `X-Frame-Options: SAMEORIGIN`, so any
 *     iframe we hand it lands on a blank page.
 *   * `*.hf.space` Spaces with `hf_oauth: true` (our conversation demo is
 *     one) trigger that login redirect as soon as the page boots.
 *   * Using the system browser gives the user access to their existing
 *     HF cookies and to saved passwords / 2FA flows.
 */
export async function openExternalUrl(url: string): Promise<void> {
  await tauriOpenUrl(url);
}
