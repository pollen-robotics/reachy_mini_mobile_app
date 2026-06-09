/**
 * Hidden-authors hook - the "block abusive users" pillar of the
 * Apple App Review guideline 1.2 (UGC) compliance work.
 *
 * The user can hide all apps published by a given Hugging Face
 * author with one tap from the per-app kebab menu
 * (`AppActionsMenu`). Hidden authors are persisted in
 * `localStorage` and applied client-side: the apps list filters
 * them out before any virtualisation / search / categorisation
 * runs, so the user simply doesn't see them anywhere in the
 * Apps tab. The revoke list lives in the `HelpAndSupportOverlay`
 * so the user can un-hide an author after a misclick.
 *
 * Design notes
 * ────────────
 * - Key by `author` (not `app.id`): hiding the author is the
 *   stronger affordance and the one Apple cares about
 *   ("block abusive USERS"). If we ever need to hide a single
 *   app independently, that's a different feature with a
 *   different store.
 * - No server roundtrip. The `mobile_visible` server-side flag
 *   (separate work) is the platform-level kill-switch; this
 *   hook is the user-level escape hatch.
 *
 * Shared store
 * ────────────
 * The state is hoisted to module-level (not `useState` per hook
 * instance) so every consumer reads/writes the same source of
 * truth. This is what guarantees that when `AppActionsMenu` calls
 * `hide(author)`, the `AppsTabView`'s filter and the
 * `HelpAndSupportOverlay`'s revoke list both re-render
 * immediately. The previous per-instance `useState`
 * implementation only synced via the `storage` event, which
 * Chrome/Safari deliberately do NOT fire in the same tab that
 * triggered the write - hence the visible delay before a hidden
 * author actually disappeared from the catalog.
 *
 * `useSyncExternalStore` is React's blessed pattern for this and
 * also gives us concurrent-rendering safety for free (no tearing
 * if React paints two sub-trees that both read from the store
 * during the same commit).
 *
 * Privacy
 * ───────
 * The list is a plain string array of HF usernames. It does
 * not leave the device. It's not synced across phones; if the
 * user reinstalls the app, the hidden list resets.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** localStorage key. Same `reachy.` namespace as the pin store. */
const STORAGE_KEY = 'reachy.apps.hiddenAuthors';

interface UseHiddenAuthorsReturn {
  /** Author ids in insertion order (most recent at the end). */
  ids: string[];
  /** O(1) membership lookup; stable identity per `ids` change. */
  set: ReadonlySet<string>;
  /** Hide every app published by this author. No-op if already hidden. */
  hide: (author: string) => void;
  /** Reveal apps from this author again. No-op if not hidden. */
  unhide: (author: string) => void;
  /** Clear the entire hidden list. Used by the "Reset" affordance in Settings. */
  clear: () => void;
  /** Convenience: is this author currently hidden? */
  isHidden: (author: string | null | undefined) => boolean;
}

function readStorage(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function writeStorage(ids: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage may be unavailable (private mode on iOS,
    // quota exceeded). Silently fail; the in-memory state still
    // reflects the user's action this session.
  }
}

// ───────────────────────────────────────────────────────────
// Module-level shared store
// ───────────────────────────────────────────────────────────
//
// `snapshot` is the single source of truth read by every
// `useHiddenAuthors()` consumer. It's a frozen array so React
// can identity-compare it cheaply between renders; we replace it
// (never mutate) on every write so subscribers see a new
// reference and re-render.

let snapshot: ReadonlyArray<string> = Object.freeze(readStorage());
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ReadonlyArray<string> {
  return snapshot;
}

function setSnapshot(next: ReadonlyArray<string>): void {
  if (next === snapshot) return;
  snapshot = Object.freeze([...next]);
  writeStorage([...snapshot]);
  notify();
}

// Cross-tab / cross-WebView sync. The `storage` event only fires
// on tabs *other* than the one that wrote the value, so it's the
// right channel for syncing across split-screen WebViews on iPad
// or two browser tabs - same-tab consumers are already covered
// by the shared module state above.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    snapshot = Object.freeze(readStorage());
    notify();
  });
}

// ───────────────────────────────────────────────────────────
// Hook
// ───────────────────────────────────────────────────────────

export function useHiddenAuthors(): UseHiddenAuthorsReturn {
  const frozenIds = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Materialise a mutable copy at the hook boundary so consumers
  // don't accidentally try to push to a frozen array. The
  // identity changes only when the frozen snapshot changes, so
  // `useMemo` keeps it stable across unrelated re-renders.
  const ids = useMemo(() => [...frozenIds], [frozenIds]);
  const set = useMemo(() => new Set(ids), [ids]);

  const hide = useCallback((author: string): void => {
    if (snapshot.includes(author)) return;
    setSnapshot([...snapshot, author]);
  }, []);

  const unhide = useCallback((author: string): void => {
    if (!snapshot.includes(author)) return;
    setSnapshot(snapshot.filter((x) => x !== author));
  }, []);

  const clear = useCallback((): void => {
    if (snapshot.length === 0) return;
    setSnapshot([]);
  }, []);

  const isHidden = useCallback(
    (author: string | null | undefined): boolean => {
      if (!author) return false;
      return set.has(author);
    },
    [set],
  );

  return {
    ids,
    set,
    hide,
    unhide,
    clear,
    isHidden,
  };
}
