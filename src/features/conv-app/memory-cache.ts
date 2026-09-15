/**
 * The robot's long-term memory, as the phone sees it.
 *
 * The facts live on the robot: its `remember` tool writes them, and only the
 * conversation app can read them. That app runs only while a conversation
 * runs, and the settings panel disables its memory controls exactly then. So
 * the phone keeps a cache of the last list it saw, and defers the one
 * destructive action to the next conversation start, alongside the settings
 * push (see `sync-settings.ts`).
 *
 * The cache is display-only. It is refreshed from the robot on every
 * conversation start, so it is real data, at worst one session old.
 */
import { useSyncExternalStore } from 'react';

import type { MemoryFact } from './client';

const CACHE_KEY = 'reachyMini.memory.robotCache.v1';
const PENDING_CLEAR_KEY = 'reachyMini.memory.pendingClear';

type Listener = () => void;

const listeners = new Set<Listener>();
let facts: readonly MemoryFact[] = readCache();
let clearPending = readPendingClear();

function safeStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

function readCache(): readonly MemoryFact[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CACHE_KEY) ?? 'null');
    return Array.isArray(parsed) ? (parsed as MemoryFact[]) : [];
  } catch (err) {
    console.warn('[memory] failed to read the cache:', err);
    return [];
  }
}

function readPendingClear(): boolean {
  return safeStorage()?.getItem(PENDING_CLEAR_KEY) === '1';
}

function persist(): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(facts));
    if (clearPending) storage.setItem(PENDING_CLEAR_KEY, '1');
    else storage.removeItem(PENDING_CLEAR_KEY);
  } catch (err) {
    // A full or disabled storage only costs us the cache across launches.
    console.warn('[memory] failed to persist the cache:', err);
  }
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.warn('[memory] listener threw:', err);
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The last list read from the robot. Empty until the first conversation. */
export function getFacts(): readonly MemoryFact[] {
  return facts;
}

/** Replace the cache with what the robot just reported. */
export function cacheFacts(next: readonly MemoryFact[]): void {
  facts = next;
  persist();
  emit();
}

/**
 * Forget everything. The robot cannot be reached while the conversation is
 * stopped, so this empties the cache now and asks the next conversation start
 * to clear the robot too.
 */
export function requestClear(): void {
  facts = [];
  clearPending = true;
  persist();
  emit();
}

export function isClearPending(): boolean {
  return clearPending;
}

export function consumeClearPending(): void {
  clearPending = false;
  persist();
}

/** React binding for the settings panel's memory section. */
export function useRobotMemory(): {
  facts: readonly MemoryFact[];
  clear: () => void;
} {
  return {
    facts: useSyncExternalStore(subscribe, getFacts, getFacts),
    clear: requestClear,
  };
}
