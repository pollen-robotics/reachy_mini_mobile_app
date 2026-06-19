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
 * Flag marking that the one-time "pin the official Pollen apps by
 * default" seeding has run. Stored separately from the pinned ids so
 * that once a user has been seeded, unpinning an official app sticks
 * (we never re-add it on the next catalog load).
 */
const SEEDED_KEY = 'reachy.apps.pinnedSeeded';

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
  /**
   * Replace the pinned order with `orderedIds`. Used by the launcher's
   * drag-to-reorder. Defensive: only ids currently pinned are kept (any
   * unknown id is dropped) and any currently-pinned id missing from the
   * argument is appended at the end, so a partial / stale order can
   * never silently lose or duplicate a pin.
   */
  reorder: (orderedIds: string[]) => void;
  /**
   * One-time seeding of the default pinned apps (the official Pollen
   * apps). Pins every id in `defaultIds` that isn't already pinned,
   * but only on the very first call EVER (guarded by a persisted
   * flag). Subsequent calls - and calls after the user has curated
   * their pins - are no-ops, so unpinning a default sticks. Pass the
   * official ids once the catalog has loaded; an empty list is
   * ignored so we wait for the catalog rather than marking the seed
   * done prematurely.
   */
  seedDefaults: (defaultIds: string[]) => void;
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

function readSeeded(): boolean {
  try {
    return localStorage.getItem(SEEDED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSeeded(): void {
  try {
    localStorage.setItem(SEEDED_KEY, '1');
  } catch {
    // Same private-mode / quota caveat as `writeStorage`.
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

  const reorder = useCallback((orderedIds: string[]): void => {
    setIds((prev) => {
      const prevSet = new Set(prev);
      // Keep only ids that are actually pinned, in the requested order.
      const next = orderedIds.filter((id) => prevSet.has(id));
      // Append any pinned id the caller forgot (e.g. an entry hidden
      // from the visible grid because its app is unpublished) so we
      // never drop a pin.
      const nextSet = new Set(next);
      for (const id of prev) {
        if (!nextSet.has(id)) next.push(id);
      }
      // No-op guard: bail if the order is unchanged to avoid a
      // pointless write + re-render.
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) {
        return prev;
      }
      writeStorage(next);
      return next;
    });
  }, []);

  const seedDefaults = useCallback((defaultIds: string[]): void => {
    // Already seeded once → never touch the user's curated pins again.
    if (readSeeded()) return;
    // Catalog not loaded yet (no official ids to seed). Don't mark the
    // seed done; wait for a later call once the ids are known.
    if (defaultIds.length === 0) return;
    setIds((prev) => {
      const next = [...prev];
      for (const id of defaultIds) {
        if (!next.includes(id) && next.length < MAX_PINNED) next.push(id);
      }
      writeStorage(next);
      return next;
    });
    writeSeeded();
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
    reorder,
    seedDefaults,
    canPinMore: ids.length < MAX_PINNED,
    isPinned,
    recentlyAddedId,
  };
}
