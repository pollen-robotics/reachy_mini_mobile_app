/**
 * Theme-preference runtime store.
 *
 * Tiny pub/sub mirroring `features/conversation-language/store.ts`
 * on purpose - both expose a single user-controlled choice that
 * needs to:
 *
 *   1. survive a hard refresh (localStorage roundtrip on every set),
 *   2. drive the React tree (root `<Root>` consumes via
 *      `useResolvedThemeMode()` to pick the MUI theme),
 *   3. stay reactive to the OS appearance when the user picked the
 *      `system` option (we hook `prefers-color-scheme` once at
 *      module load and emit on every change so the resolved value
 *      tracks the OS without each consumer mounting its own
 *      `matchMedia`).
 *
 * Initialisation runs synchronously at module evaluation so the
 * very first React render already reads the persisted value - no
 * flash of OS-themed content on cold start.
 */
import { useSyncExternalStore } from 'react';

import {
  readThemeModeRaw,
  resolveStoredMode,
  writeThemeMode,
} from './storage';
import {
  DEFAULT_THEME_MODE,
  type ResolvedThemeMode,
  type ThemeMode,
} from './types';

type Listener = () => void;

let mode: ThemeMode = resolveStoredMode(readThemeModeRaw());
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (err) {
      console.warn('[theme-preference] listener threw:', err);
    }
  }
}

/**
 * Live `prefers-color-scheme` media query, captured once. When the
 * OS appearance changes (e.g. user toggles dark mode in iOS
 * Control Center) we emit so consumers reading the *resolved*
 * mode while in `system` see the change immediately.
 *
 * SSR / non-browser guards are present even though the app only
 * runs inside Tauri's WebView - they make the module trivially
 * unit-testable in jsdom and protect us if a future build ever
 * runs the bundle through a static prerender.
 */
const prefersDarkMql: MediaQueryList | null =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

if (prefersDarkMql) {
  // `addEventListener('change', ...)` is the modern API; older
  // Safari only had `addListener`. We try the modern path first
  // and fall back so the wired-up listener works on every iOS
  // version Tauri's WKWebView is happy to host.
  const handler = (): void => {
    if (mode === 'system') emit();
  };
  if (typeof prefersDarkMql.addEventListener === 'function') {
    prefersDarkMql.addEventListener('change', handler);
  } else if (typeof prefersDarkMql.addListener === 'function') {
    prefersDarkMql.addListener(handler);
  }
}

function osPrefersDark(): boolean {
  return prefersDarkMql ? prefersDarkMql.matches : false;
}

/* ─── External store API ──────────────────────────────────────────── */

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Raw user selection (`'system' | 'light' | 'dark'`). Stable
 *  for the lifetime of the current selection; only changes
 *  through `setThemeMode`. */
export function getThemeMode(): ThemeMode {
  return mode;
}

/** Resolved palette (`'light' | 'dark'`). Collapses `system` to
 *  the live OS preference. Re-emits on OS appearance change so
 *  consumers stay in sync. */
export function getResolvedThemeMode(): ResolvedThemeMode {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return osPrefersDark() ? 'dark' : 'light';
}

/**
 * Switch the user's theme preference. Persists to localStorage
 * in the same tick. No-op when the value is already active.
 * Unknown inputs fall back to the default rather than leaving
 * the store in a half-set state.
 */
export function setThemeMode(next: ThemeMode | string): void {
  const resolved = resolveStoredMode(next);
  if (resolved === mode) return;
  mode = resolved;
  writeThemeMode(resolved);
  emit();
}

/** Reset to the default (`system`). Mainly useful for tests +
 *  a future "restore defaults" affordance in the settings sheet. */
export function resetThemeMode(): void {
  setThemeMode(DEFAULT_THEME_MODE);
}

/* ─── React hooks ─────────────────────────────────────────────────── */

/** React hook reading the raw user selection. Use this for the
 *  toggle UI itself (so the highlighted option matches the
 *  user's pick, not the resolved palette). */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, getThemeMode);
}

/** React hook reading the resolved palette. Use this at the
 *  `ThemeProvider` boundary - it tracks both the user's pick AND
 *  the OS appearance when the pick is `system`. */
export function useResolvedThemeMode(): ResolvedThemeMode {
  return useSyncExternalStore(subscribe, getResolvedThemeMode);
}
