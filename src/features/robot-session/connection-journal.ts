/**
 * Persistent journal of connection incidents (degradations, SDK
 * re-dials, fatals, in-place recoveries).
 *
 * Why it exists: release builds have no console a user can reach, and
 * the WebView's console is wiped on every reload. After "it
 * disconnected", the cause (data-channel silence vs ICE vs a daemon
 * restart) used to be gone the moment the user reopened the app. The
 * journal keeps the last `MAX_ENTRIES` events in `localStorage` so About
 * & diagnostics can show and copy them into a bug report.
 *
 * Best effort by design: storage can be missing or throw (private mode,
 * quota), in which case the journal just lives in memory for the run.
 */
import { useSyncExternalStore } from 'react';

export type ConnectionEventKind =
  | 'degraded'
  | 'recovered'
  | 'redialing'
  | 'redialed'
  | 'fatal'
  | 'auto-recover'
  | 'auto-recover-retry'
  | 'auto-recovered'
  | 'auto-recover-gave-up';

export interface ConnectionEvent {
  /** Epoch ms. */
  at: number;
  kind: ConnectionEventKind;
  detail?: string;
}

const STORAGE_KEY = 'reachy.connection-journal.v1';
const MAX_ENTRIES = 50;
const MAX_DETAIL_LENGTH = 300;

let cache: ConnectionEvent[] | null = null;
const listeners = new Set<() => void>();

function load(): ConnectionEvent[] {
  if (cache) return cache;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? (parsed as ConnectionEvent[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

export function recordConnectionEvent(kind: ConnectionEventKind, detail?: string): void {
  const entry: ConnectionEvent = { at: Date.now(), kind };
  if (detail) entry.detail = detail.slice(0, MAX_DETAIL_LENGTH);
  // New array on every write: `useSyncExternalStore` compares snapshots
  // by identity.
  cache = [...load(), entry].slice(-MAX_ENTRIES);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full / unavailable: keep the in-memory copy.
  }
  for (const listener of listeners) listener();
}

export function readConnectionJournal(): readonly ConnectionEvent[] {
  return load();
}

export function subscribeConnectionJournal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Plain-text dump for the clipboard, oldest first. */
export function formatConnectionJournal(
  events: readonly ConnectionEvent[],
  header: readonly string[] = [],
): string {
  const lines = events.map((e) => {
    const at = new Date(e.at).toISOString();
    return e.detail ? `${at} ${e.kind}: ${e.detail}` : `${at} ${e.kind}`;
  });
  return [...header, ...lines].join('\n');
}

export function useConnectionJournal(): readonly ConnectionEvent[] {
  return useSyncExternalStore(subscribeConnectionJournal, readConnectionJournal);
}

/** Test hook: forget the in-memory copy so the next read hits storage. */
export function resetConnectionJournalCacheForTests(): void {
  cache = null;
}
