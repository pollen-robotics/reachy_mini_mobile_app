/**
 * Long-term conversation memory ("Reachy remembers things about me").
 *
 * Scope
 * ─────
 * Mobile-app only. Mirrors what ChatGPT calls "Memory": the assistant
 * itself decides what is worth remembering and writes short, atomic
 * facts into a list via the `remember` tool. The list is loaded at
 * the start of every conversation and prepended to the system prompt
 * so the model sees the user's context before its first reply.
 *
 * Storage
 * ───────
 * Plain `localStorage` (key `reachyMini.memory.v1`), encoded as a
 * minimal JSON shape:
 *
 *   {
 *     facts: [
 *       { id: "m_1734567890_abc", text: "Likes jazz", createdAt: 1734567890123 }
 *     ]
 *   }
 *
 * Why `localStorage` and not the daemon
 * ─────────────────────────────────────
 * The daemon is intentionally untouched on this iteration: keeping
 * memories in the browser means a single-app change with zero new
 * HTTP surfaces. The cost is that the memory is bound to the
 * device/browser the user runs the mobile app from - a tradeoff
 * that's fine for a first cut. A future patch can swap the storage
 * adapter without changing the public API: the `remember`/`forget`
 * tools and the prompt-injection format stay the same.
 *
 * Design notes
 * ────────────
 * - Atomic facts (1 short sentence each). The model is instructed
 *   to split compound information itself; the store doesn't try to
 *   parse anything.
 * - Free-text "forget by query": substring match, case-insensitive,
 *   first match wins. The model is the right place to disambiguate
 *   ("which note about jazz?") - it gets a list of candidates back
 *   when several match and can re-call `forget` with a more
 *   specific query.
 * - Soft cap of `MAX_FACTS` to bound prompt growth. Past the cap
 *   we drop the oldest entries on add. The cap is generous (60)
 *   because the realtime model has plenty of context budget; the
 *   real ceiling is "a paragraph the user can read at a glance"
 *   in the Memory dialog.
 */

const STORAGE_KEY = 'reachyMini.memory.v1';
const SCHEMA_VERSION = 1;
const MAX_FACTS = 60;

/**
 * On-disk shape. Wrapped in an envelope with a schema version so a
 * future migration can detect old data without guessing at the JSON
 * structure.
 */
interface PersistedMemory {
  version: number;
  facts: MemoryFact[];
}

export interface MemoryFact {
  /** Stable client-side id, used by the UI to key list rows. */
  id: string;
  /** Short, single-sentence statement about the user. */
  text: string;
  /** Epoch ms; the UI shows a relative timestamp ("2 days ago"). */
  createdAt: number;
}

type Listener = (facts: readonly MemoryFact[]) => void;

let cache: MemoryFact[] | null = null;
const listeners = new Set<Listener>();

/**
 * Lazily read from localStorage. We cache the in-memory copy because
 * the React subscription path calls `list()` on every render: hitting
 * `localStorage.getItem` + `JSON.parse` per render gets noticeable on
 * the conversation screen, which renders 10+ times during state
 * transitions.
 *
 * Returns a fresh array each call so the React snapshot stays
 * referentially stable across reads (spread once, then handed out
 * by reference until a write invalidates the cache).
 */
function readPersisted(): MemoryFact[] {
  if (cache !== null) return cache;
  if (typeof window === 'undefined') {
    cache = [];
    return cache;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = [];
      return cache;
    }
    const parsed = JSON.parse(raw) as Partial<PersistedMemory>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.facts)) {
      cache = [];
      return cache;
    }
    // Defensive: drop any entry that isn't shaped like a MemoryFact,
    // so a partial corruption doesn't break the prompt injection.
    cache = parsed.facts.filter(
      (f): f is MemoryFact =>
        typeof f === 'object' &&
        f !== null &&
        typeof f.id === 'string' &&
        typeof f.text === 'string' &&
        typeof f.createdAt === 'number',
    );
    return cache;
  } catch (err) {
    console.warn('[memory] failed to read store:', err);
    cache = [];
    return cache;
  }
}

function writePersisted(facts: MemoryFact[]): void {
  cache = facts;
  if (typeof window === 'undefined') return;
  try {
    const payload: PersistedMemory = { version: SCHEMA_VERSION, facts };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    // QuotaExceededError on a full localStorage is the realistic case
    // here; we keep the in-memory cache so the running session still
    // sees the new fact and warn the user via console.
    console.warn('[memory] failed to write store:', err);
  }
  for (const listener of listeners) {
    try {
      listener(facts);
    } catch (err) {
      console.warn('[memory] listener threw:', err);
    }
  }
}

function makeId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Public API.
 *
 * Both the conversation engine (via the `remember`/`forget` tools)
 * and the React UI talk to this same singleton. We deliberately
 * expose it as a plain object instead of a class so consumers can
 * import individual functions and tree-shaking still works.
 */
export const memoryStore = {
  /**
   * Snapshot of the current memory list, newest-first. Returns the
   * cached array - do NOT mutate it; callers that need a copy should
   * spread it.
   */
  list(): readonly MemoryFact[] {
    return readPersisted();
  },

  /**
   * Append a new fact. Returns the stored entry (with the assigned
   * id) so the caller can echo it back to the model. Trims and
   * collapses whitespace; rejects empty / overly long inputs so the
   * model can't accidentally pollute the prompt with a paragraph.
   */
  add(text: string): MemoryFact | null {
    const normalized = normalize(text);
    if (!normalized) return null;
    if (normalized.length > 280) {
      // The model gets a hint via the tool description that facts
      // must stay short; truncate as a safety net rather than
      // silently dropping, so the user still sees something in the
      // UI even if the model misbehaved.
      return this.add(`${normalized.slice(0, 277)}...`);
    }
    // Dedupe: identical-text facts are no-ops. We keep the existing
    // id so the UI doesn't re-animate a fact that was already there.
    const existing = readPersisted().find(
      (f) => f.text.toLowerCase() === normalized.toLowerCase(),
    );
    if (existing) return existing;

    const fact: MemoryFact = {
      id: makeId(),
      text: normalized,
      createdAt: Date.now(),
    };
    const next = [fact, ...readPersisted()];
    // Soft cap by FIFO: drop the OLDEST entries past MAX_FACTS so
    // the prompt size stays bounded. Newest are kept on top of the
    // list so they're the first the model sees.
    const trimmed = next.slice(0, MAX_FACTS);
    writePersisted(trimmed);
    return fact;
  },

  /**
   * Remove a fact by id (UI path) or by free-text query (tool path).
   * Returns the removed entries so the caller can format a feedback
   * line for the model. When the query matches multiple facts, ALL
   * matches are returned but only the FIRST is removed - this lets
   * the model decide whether to call `forget` again on the others.
   */
  forget(opts: { id?: string; query?: string }): {
    removed: MemoryFact | null;
    candidates: readonly MemoryFact[];
  } {
    const facts = readPersisted();
    if (opts.id) {
      const removed = facts.find((f) => f.id === opts.id) ?? null;
      if (!removed) return { removed: null, candidates: [] };
      writePersisted(facts.filter((f) => f.id !== opts.id));
      return { removed, candidates: [removed] };
    }
    const query = normalize(opts.query ?? '').toLowerCase();
    if (!query) return { removed: null, candidates: [] };
    const candidates = facts.filter((f) =>
      f.text.toLowerCase().includes(query),
    );
    if (candidates.length === 0) return { removed: null, candidates: [] };
    const target = candidates[0];
    writePersisted(facts.filter((f) => f.id !== target.id));
    return { removed: target, candidates };
  },

  /** Wipe all facts. UI-only path; no tool calls this. */
  clear(): void {
    if (readPersisted().length === 0) return;
    writePersisted([]);
  },

  /**
   * Subscribe to write events. Called once per write with the new
   * snapshot; not called for reads. Returns an unsubscribe function
   * so React effects can clean up symmetrically.
   *
   * Used by `useMemoryStore` to back a `useSyncExternalStore` hook.
   * No tear-down is needed beyond removing the listener.
   */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /**
   * Build the prompt fragment that gets prepended to the realtime
   * `instructions` at session start. Empty string when the user has
   * no memories so we don't waste tokens on an empty section.
   *
   * The format is deliberately plain Markdown-ish: short header,
   * one bullet per fact, no metadata. This matches how OpenAI's
   * own memory feature formats the prompt and gives the model a
   * predictable shape to scan.
   */
  formatForPrompt(): string {
    const facts = readPersisted();
    if (facts.length === 0) return '';
    const bullets = facts.map((f) => `- ${f.text}`).join('\n');
    return [
      'Things you remember about the user (use this context naturally,',
      'do not recite the list verbatim):',
      bullets,
    ].join('\n');
  },
};

/**
 * Test-only reset. Not exported in the public engine API; only used
 * by Vitest helpers if we add unit tests for the store.
 */
export function _resetMemoryStoreForTests(): void {
  cache = null;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignored
    }
  }
}
