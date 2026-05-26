/**
 * Theme-preference persistence layer.
 *
 * Single localStorage slot:
 *
 *   `reachyMini.themeMode` (string)
 *       One of `'system' | 'light' | 'dark'`. Read synchronously
 *       on cold start so the first paint already matches the
 *       user's choice (no flash of OS-themed content).
 *
 * Failures (private mode, quota, missing localStorage in test
 * envs, ...) are swallowed with a single warn line; the in-memory
 * store stays authoritative for the current session.
 *
 * Validation against the allowed values happens in the store
 * (`resolveStoredMode`), not here - storage is the dumb key/value
 * boundary, mirroring `features/conversation-language/storage.ts`.
 */
import { DEFAULT_THEME_MODE, type ThemeMode } from './types';

export const THEME_MODE_KEY = 'reachyMini.themeMode';

function safeStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

/**
 * Read the persisted theme mode. Returns the default when storage
 * is unavailable or the value is missing / unrecognised. The
 * caller should still validate via `resolveStoredMode` before
 * trusting the result, since older builds may have written values
 * that no longer exist.
 */
export function readThemeModeRaw(): string {
  const storage = safeStorage();
  if (!storage) return DEFAULT_THEME_MODE;
  try {
    const raw = storage.getItem(THEME_MODE_KEY);
    if (raw && raw.trim().length > 0) return raw.trim();
  } catch (err) {
    console.warn('[theme-preference] failed to read mode:', err);
  }
  return DEFAULT_THEME_MODE;
}

export function writeThemeMode(mode: ThemeMode): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(THEME_MODE_KEY, mode);
  } catch (err) {
    console.warn('[theme-preference] failed to write mode:', err);
  }
}

const VALID_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

/**
 * Coerce an arbitrary string to a `ThemeMode`. Unknown values
 * fall back to the default rather than crashing the boot path.
 * Exported so the `ErrorBoundary` (which lives outside the React
 * tree's store subscription) can read the same value with the
 * same validation logic.
 */
export function resolveStoredMode(raw: string): ThemeMode {
  return (VALID_MODES as readonly string[]).includes(raw)
    ? (raw as ThemeMode)
    : DEFAULT_THEME_MODE;
}
