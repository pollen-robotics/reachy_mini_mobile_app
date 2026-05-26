/**
 * Public re-exports for the theme-preference feature. Single
 * entry point so callers stay decoupled from the internal
 * file split (storage / store / types).
 */
export {
  getResolvedThemeMode,
  getThemeMode,
  resetThemeMode,
  setThemeMode,
  subscribe,
  useResolvedThemeMode,
  useThemeMode,
} from './store';
export { resolveStoredMode, readThemeModeRaw } from './storage';
export {
  DEFAULT_THEME_MODE,
  type ResolvedThemeMode,
  type ThemeMode,
} from './types';
