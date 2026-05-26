/**
 * Theme-preference feature - public types.
 *
 * Three values, mirroring iOS Settings -> Display & Brightness and
 * Android system theme picker:
 *
 *   - `system` : follow `prefers-color-scheme` at runtime. Default
 *     for first-launch users who have not opened the toggle yet.
 *   - `light`  : force the light palette regardless of OS state.
 *   - `dark`   : force the dark palette regardless of OS state.
 *
 * The "resolved" mode is what the React tree actually consumes; it
 * collapses `system` to `light` or `dark` based on the live media
 * query. See `store.ts` for the resolution helper.
 */

export type ThemeMode = 'system' | 'light' | 'dark';

export type ResolvedThemeMode = 'light' | 'dark';

export const DEFAULT_THEME_MODE: ThemeMode = 'system';
