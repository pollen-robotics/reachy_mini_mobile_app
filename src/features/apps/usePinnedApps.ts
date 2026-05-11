/**
 * Pinned apps hook.
 *
 * Persists the list of pinned app ids in `localStorage` and exposes
 * a tiny imperative API (toggle / canPinMore / isPinned) plus a
 * stable derived `Set` for O(1) membership lookups. No server
 * roundtrip in V1; pin state is purely local.
 *
 * Storage layout
 * ──────────────
 * Key: `reachy.apps.pinnedIds`
 * Value: JSON-encoded `string[]`, insertion-ordered (the order is
 * the render order in the pinned rail).
 *
 * Cross-tab sync
 * ──────────────
 * We listen to `storage` events so the rail stays in sync if the
 * user has the app open in two WebView contexts (rare, but the
 * behaviour matches the rest of the app's local state).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

/** localStorage key. Namespaced under `reachy.` to share the prefix
 * with other mobile-side preferences. */
const STORAGE_KEY = 'reachy.apps.pinnedIds';

/**
 * Maximum number of pinned apps. Picked to fit 3 rows of 4 tiles
 * on a 360 px viewport with the V1 pinned-tile size. The 13th pin
 * attempt prompts the user to unpin something first.
 */
export const MAX_PINNED = 12;

interface UsePinnedAppsReturn {
  /** Insertion-ordered array of pinned ids. */
  ids: string[];
  /** O(1) membership lookup, stable identity per `ids` change. */
  set: ReadonlySet<string>;
  /**
   * Toggle the pinned state of an id. Returns the resulting state
   * (`true` if the id ends up pinned, `false` if it ends up
   * unpinned, including when the cap rejects the addition).
   */
  toggle: (id: string) => boolean;
  /** Pin an id (no-op if already pinned or if cap reached). */
  pin: (id: string) => boolean;
  /** Unpin an id (no-op if not pinned). */
  unpin: (id: string) => void;
  /** Whether the cap allows another pin. Equivalent to `ids.length < MAX_PINNED`. */
  canPinMore: boolean;
  /** Convenience: is this id currently pinned? */
  isPinned: (id: string) => boolean;
  /**
   * The id of the last app that was pinned via this hook. Set
   * synchronously by `pin()` / `toggle()` and auto-reset after
   * `RECENT_PIN_TTL_MS` so consumers can use it as a one-shot
   * signal to drive the pop-in animation on the freshly added
   * tile. `null` means "no recent pin to celebrate".
   *
   * Lives in the hook (not in the consuming component) so the
   * signal survives the unmount of the pinned panel: the very
   * first pin transitions the `IntroPanel` away and mounts the
   * `PinnedGrid` fresh; without this hook-level signal the new
   * grid would have no notion of "this id just landed" and the
   * pop-in would silently not fire.
   */
  recentlyAddedId: string | null;
}

/**
 * How long the `recentlyAddedId` stays set after a successful
 * pin. Picked just above the tile pop-in animation budget
 * (80 ms delay + 240 ms keyframe = 320 ms) with a small buffer
 * so a brief tab-switch round-trip during the animation doesn't
 * lose the signal mid-flight.
 */
const RECENT_PIN_TTL_MS = 500;

function readStorage(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: drop non-string entries silently. A corrupted
    // value should never crash the apps tab.
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

export function usePinnedApps(): UsePinnedAppsReturn {
  const [ids, setIds] = useState<string[]>(() => readStorage());
  const [recentlyAddedId, setRecentlyAddedId] = useState<string | null>(null);

  // Cross-tab / cross-WebView sync: re-read on `storage` events.
  // Filter on the key to avoid wasted re-renders for unrelated
  // updates (auth, prefs).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setIds(readStorage());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Auto-reset `recentlyAddedId` so the signal is one-shot. Each
  // successful `pin()` re-arms the timer (replaces the previous
  // `setRecentlyAddedId(...)`); `useEffect` then re-sets up a
  // fresh clear-timeout for the new value.
  useEffect(() => {
    if (recentlyAddedId === null) return;
    const handle = window.setTimeout(() => {
      setRecentlyAddedId(null);
    }, RECENT_PIN_TTL_MS);
    return () => window.clearTimeout(handle);
  }, [recentlyAddedId]);

  const set = useMemo(() => new Set(ids), [ids]);

  const pin = useCallback(
    (id: string): boolean => {
      let didPin = false;
      setIds((prev) => {
        if (prev.includes(id)) return prev;
        if (prev.length >= MAX_PINNED) return prev;
        const next = [...prev, id];
        writeStorage(next);
        didPin = true;
        return next;
      });
      if (didPin) {
        setRecentlyAddedId(id);
      }
      return didPin;
    },
    [],
  );

  const unpin = useCallback((id: string): void => {
    setIds((prev) => {
      if (!prev.includes(id)) return prev;
      const next = prev.filter((x) => x !== id);
      writeStorage(next);
      return next;
    });
  }, []);

  const toggle = useCallback(
    (id: string): boolean => {
      // Use the synchronous `ids` snapshot rather than reading from
      // `setIds`'s prev so the return value is the *intent* of this
      // call (true = should be pinned). The state update below
      // mirrors that intent.
      const currentlyPinned = set.has(id);
      if (currentlyPinned) {
        unpin(id);
        return false;
      }
      const wasPinned = pin(id);
      // If cap rejects, `pin()` returns false and the id stays
      // unpinned: surface that to the caller so it can show a
      // "unpin first" toast.
      return wasPinned;
    },
    [set, pin, unpin],
  );

  const isPinned = useCallback((id: string) => set.has(id), [set]);

  return {
    ids,
    set,
    toggle,
    pin,
    unpin,
    canPinMore: ids.length < MAX_PINNED,
    isPinned,
    recentlyAddedId,
  };
}
