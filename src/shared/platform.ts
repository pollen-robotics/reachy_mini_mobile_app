/**
 * Platform detection — single source of truth for the app.
 *
 * Wraps `@tauri-apps/plugin-os`. In Tauri v2 the plugin's `platform()`
 * is synchronous: it reads compile-time values the runtime injects on
 * `window.__TAURI_OS_PLUGIN_INTERNALS__`.
 *
 * Outside the Tauri runtime (`yarn dev` in a plain browser, Storybook,
 * Vitest, SSR-like tooling) that global is absent and the plugin
 * throws. We treat that case as "browser / unknown desktop" so the
 * rest of the app degrades gracefully and platform-specific branches
 * default to the non-mobile path.
 *
 * Add new derived predicates HERE, not at call sites. That keeps every
 * platform-conditional behaviour auditable with a single
 * `rg 'isMobilePlatform|isDesktopPlatform'`.
 */
import { platform, type Platform } from '@tauri-apps/plugin-os';

type ResolvedPlatform = Platform | 'browser';

let cached: ResolvedPlatform | null = null;

function resolve(): ResolvedPlatform {
  if (cached) return cached;
  try {
    cached = platform();
  } catch {
    cached = 'browser';
  }
  return cached;
}

export function getPlatform(): ResolvedPlatform {
  return resolve();
}

/**
 * True on the two platforms that motivate the mobile-only WebRTC mic
 * dance (iOS LAN-host-candidate unlock, Android `RECORD_AUDIO` prompt).
 */
export function isMobilePlatform(): boolean {
  const p = resolve();
  return p === 'ios' || p === 'android';
}

/**
 * Inverse of `isMobilePlatform`. Includes `macos`, `linux`, `windows`,
 * and the `browser` fallback used by tests / vite-only dev.
 */
export function isDesktopPlatform(): boolean {
  return !isMobilePlatform();
}
