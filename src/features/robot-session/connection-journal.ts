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
  | 'auto-recover-gave-up'
  | 'signaling-lost'
  | 'signaling-restored'
  | 'signaling-session-ended';

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

/** Storage is untrusted (older builds, manual edits): keep well-formed entries only. */
function isEvent(value: unknown): value is ConnectionEvent {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.at === 'number' &&
    Number.isFinite(e.at) &&
    typeof e.kind === 'string' &&
    (e.detail === undefined || typeof e.detail === 'string')
  );
}

function load(): ConnectionEvent[] {
  if (cache) return cache;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? parsed.filter(isEvent) : [];
  } catch {
    cache = [];
  }
  return cache;
}

/**
 * Keep identifiers out of the journal, since it is copied into bug reports:
 * peer / session ids (UUIDs), robot names and HF tokens.
 */
export function scrubDetail(detail: string): string {
  return detail
    .replace(/hf_[A-Za-z0-9_-]{8,}/g, '<token>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\bname=[^,)]*/g, 'name=<robot>');
}

const ATTEMPT_KINDS: readonly ConnectionEventKind[] = ['auto-recover', 'auto-recover-retry'];

export function recordConnectionEvent(kind: ConnectionEventKind, detail?: string): void {
  const clean = detail ? scrubDetail(detail).slice(0, MAX_DETAIL_LENGTH) : undefined;
  const events = load();
  const last = events.at(-1);
  // A recovery attempt that fails logs its fatal right after the attempt:
  // fold it into that entry, so an incident costs one slot per attempt.
  if (kind === 'fatal' && last && ATTEMPT_KINDS.includes(last.kind) && !last.detail?.includes('failed:')) {
    const merged: ConnectionEvent = {
      ...last,
      detail: [last.detail, `failed: ${clean ?? 'unknown'}`].filter(Boolean).join(' - ').slice(0, MAX_DETAIL_LENGTH),
    };
    cache = [...events.slice(0, -1), merged];
  } else {
    const entry: ConnectionEvent = { at: Date.now(), kind };
    if (clean) entry.detail = clean;
    // New array on every write: `useSyncExternalStore` compares snapshots
    // by identity.
    cache = [...events, entry].slice(-MAX_ENTRIES);
  }
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
