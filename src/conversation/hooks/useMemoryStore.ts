/**
 * React binding for `memoryStore`.
 *
 * Implemented with `useSyncExternalStore` so that:
 *   1. The first render reads the synchronous snapshot - no flash
 *      of "0 memories" while a `useEffect` waits to fire.
 *   2. Re-renders happen exactly once per write, no matter how many
 *      components are subscribed (React batches per store).
 *   3. SSR-safe via `getServerSnapshot` returning an empty list - we
 *      never run the mobile app on the server today, but the helper
 *      stays cheap so future Next.js / Astro embedding "just works".
 *
 * The hook returns an object instead of just the array so callers
 * don't have to import `memoryStore` directly for write actions.
 * That keeps the dialog component free of cross-cutting imports.
 */
import { useCallback, useSyncExternalStore } from 'react';

import { memoryStore, type MemoryFact } from '../engine/memory';

const EMPTY: readonly MemoryFact[] = [];

export interface UseMemoryStoreResult {
  facts: readonly MemoryFact[];
  /** Manually add a fact (UI bypass; not used by the LLM tools). */
  add: (text: string) => MemoryFact | null;
  /** Remove a single fact by id. UI path. */
  remove: (id: string) => void;
  /** Wipe everything. Confirm with the user before calling. */
  clear: () => void;
}

export function useMemoryStore(): UseMemoryStoreResult {
  const facts = useSyncExternalStore(
    memoryStore.subscribe,
    memoryStore.list,
    () => EMPTY,
  );

  const add = useCallback((text: string) => memoryStore.add(text), []);
  const remove = useCallback((id: string) => {
    memoryStore.forget({ id });
  }, []);
  const clear = useCallback(() => {
    memoryStore.clear();
  }, []);

  return { facts, add, remove, clear };
}
