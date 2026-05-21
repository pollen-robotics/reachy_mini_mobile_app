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
 * Apps tab. The revoke list lives in the `HelpAndSupportSheet`
 * so the user can un-hide an author after a misclick.
 *
 * Design notes
 * ────────────
 * - Mirrors `usePinnedApps` exactly: `localStorage` + a small
 *   imperative API + cross-tab sync via the `storage` event.
 *   Same pattern means same audit story, same testability, no
 *   new dependencies.
 * - Key by `author` (not `app.id`): hiding the author is the
 *   stronger affordance and the one Apple cares about
 *   ("block abusive USERS"). If we ever need to hide a single
 *   app independently, that's a different feature with a
 *   different store.
 * - No server roundtrip. The `mobile_visible` server-side flag
 *   (separate work) is the platform-level kill-switch; this
 *   hook is the user-level escape hatch.
 *
 * Privacy
 * ───────
 * The list is a plain string array of HF usernames. It does
 * not leave the device. It's not synced across phones; if the
 * user reinstalls the app, the hidden list resets.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

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
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function writeStorage(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage may be unavailable (private mode on iOS,
    // quota exceeded). Silently fail; the in-memory state still
    // reflects the user's action this session.
  }
}

export function useHiddenAuthors(): UseHiddenAuthorsReturn {
  const [ids, setIds] = useState<string[]>(() => readStorage());

  // Cross-tab / cross-WebView sync: re-read on `storage` events.
  // The store is mutated from two surfaces (the kebab menu on
  // tiles + the revoke list inside Help & Support), and both can
  // be visible "simultaneously" on iPad / split-screen Android.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setIds(readStorage());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const set = useMemo(() => new Set(ids), [ids]);

  const hide = useCallback((author: string): void => {
    setIds((prev) => {
      if (prev.includes(author)) return prev;
      const next = [...prev, author];
      writeStorage(next);
      return next;
    });
  }, []);

  const unhide = useCallback((author: string): void => {
    setIds((prev) => {
      if (!prev.includes(author)) return prev;
      const next = prev.filter((x) => x !== author);
      writeStorage(next);
      return next;
    });
  }, []);

  const clear = useCallback((): void => {
    setIds((prev) => {
      if (prev.length === 0) return prev;
      writeStorage([]);
      return [];
    });
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
