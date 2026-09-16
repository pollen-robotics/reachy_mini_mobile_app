/**
 * Personalities persistence layer.
 *
 * Two slots in localStorage:
 *
 *   - `reachyMini.personalities.activeId` (string)
 *       Currently active personality id. Read on every conversation
 *       (re)connect to compose the realtime session.
 *
 *   - `reachyMini.personalities.catalog` (JSON array)
 *       The last catalog the robot reported, mapped to `Personality`
 *       records. It is a cache: the robot owns the list, this lets the
 *       picker draw something before the first conversation of a session.
 *
 *   - `reachyMini.personalities.pending` (JSON object)
 *       Authoring the robot has not heard yet. The personality editor is
 *       reachable while the conversation app is stopped, so a create, an
 *       edit or a delete has to wait for the next start to be pushed.
 *
 * Storage failures (private mode, quota, etc.) are swallowed with a
 * single warn log: persistence is a UX nicety, not a correctness
 * requirement, so the app stays usable even when the host browser
 * refuses to store anything.
 */
import { DEFAULT_AVATAR_URL, DEFAULT_GLOW, DEFAULT_PERSONALITY_ID, snapVoice } from './builtin';
import type { Personality } from './types';

const ACTIVE_KEY = 'reachyMini.personalities.activeId';
const CATALOG_KEY = 'reachyMini.personalities.catalog';
const PENDING_KEY = 'reachyMini.personalities.pending';
const SEEDED_KEY = 'reachyMini.personalities.seeded';
/** Where phone-authored personalities lived before the robot owned them. */
const LEGACY_CUSTOM_KEY = 'reachyMini.personalities.custom';

/** Authoring waiting for a robot to push it to. */
export interface PendingWrites {
  /** Ids created or edited on the phone, to `personalities.save`. */
  dirty: string[];
  /** Ids deleted on the phone, to `personalities.delete`. */
  deleted: string[];
}

export const NO_PENDING_WRITES: PendingWrites = { dirty: [], deleted: [] };

/**
 * Resolve a usable Storage instance, or `null` when the host has no
 * localStorage at all. Vitest's default Node environment lacks the
 * global, so this guard keeps the bootstrap path silent in tests
 * (and in any future SSR / worker context that imports the store).
 *
 * Browser private modes are NOT detected here on purpose: localStorage
 * IS defined, it just throws on `setItem` over quota. Those throws are
 * caught at the call sites below and surfaced as a single warn line so
 * we don't spam the console.
 */
function safeStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

/**
 * Read the active personality id from localStorage.
 *
 * Returns the default id (`builtin:default`) when:
 *   - localStorage is unavailable
 *   - the slot has never been written
 *   - the stored value is empty
 *
 * Validation against the actual catalog is performed by the store
 * (storage doesn't know about built-in vs. custom resolution).
 */
export function readActivePersonalityId(): string {
  const storage = safeStorage();
  if (!storage) return DEFAULT_PERSONALITY_ID;
  try {
    const raw = storage.getItem(ACTIVE_KEY);
    if (raw && raw.trim().length > 0) return raw.trim();
  } catch (err) {
    console.warn('[personalities] failed to read active id:', err);
  }
  return DEFAULT_PERSONALITY_ID;
}

/**
 * Persist the active personality id. Best-effort: no-op on storage
 * failure, the in-memory store remains the source of truth for the
 * current session.
 */
export function writeActivePersonalityId(id: string): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(ACTIVE_KEY, id);
  } catch (err) {
    console.warn('[personalities] failed to write active id:', err);
  }
}

/**
 * Read the cached catalog. Returns an empty array on any failure
 * (missing key, bad JSON, schema drift) so the caller never has to
 * handle a `null` distinct from "no robot seen yet".
 */
export function readCachedCatalog(): Personality[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(CATALOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidPersonality).map(normalisePersonality);
  } catch (err) {
    console.warn('[personalities] failed to read the cached catalog:', err);
    return [];
  }
}

/** Persist the cached catalog. Best-effort. */
export function writeCachedCatalog(list: Personality[]): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(CATALOG_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('[personalities] failed to write the cached catalog:', err);
  }
}

export function readPendingWrites(): PendingWrites {
  const storage = safeStorage();
  if (!storage) return NO_PENDING_WRITES;
  try {
    const raw = storage.getItem(PENDING_KEY);
    if (!raw) return NO_PENDING_WRITES;
    const parsed = JSON.parse(raw) as Partial<PendingWrites>;
    return {
      dirty: ids(parsed.dirty),
      deleted: ids(parsed.deleted),
    };
  } catch (err) {
    console.warn('[personalities] failed to read pending writes:', err);
    return NO_PENDING_WRITES;
  }
}

export function writePendingWrites(pending: PendingWrites): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch (err) {
    console.warn('[personalities] failed to write pending writes:', err);
  }
}

/**
 * Read the personalities the user authored before the robot owned the catalog,
 * and clear the slot so this only ever happens once. They still carry the old
 * `custom:<slug>` ids; the store renames them into the robot's namespace.
 */
export function takeLegacyCustomPersonalities(): Personality[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(LEGACY_CUSTOM_KEY);
    if (!raw) return [];
    storage.removeItem(LEGACY_CUSTOM_KEY);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidPersonality).map(normalisePersonality);
  } catch (err) {
    console.warn('[personalities] failed to read the legacy customs:', err);
    return [];
  }
}

/** Whether the bundled personalities have already been offered to a robot. */
export function readSeeded(): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    return storage.getItem(SEEDED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeSeeded(): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(SEEDED_KEY, 'true');
  } catch (err) {
    console.warn('[personalities] failed to record the seeding:', err);
  }
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Shape-check a parsed JSON entry. We deliberately stay lenient: any
 * missing optional field falls back to a default in `normaliseCustom`,
 * but the bare minimum (id + name + instructions) MUST be present
 * otherwise the entry is dropped.
 */
function isValidPersonality(value: unknown): value is Partial<Personality> & {
  id: string;
  name: string;
  instructions: string;
} {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    typeof v.instructions === 'string' &&
    v.instructions.length > 0
  );
}

function normalisePersonality(
  raw: Partial<Personality> & { id: string; name: string; instructions: string }
): Personality {
  return {
    id: raw.id,
    kind: raw.kind === 'builtin' ? 'builtin' : 'custom',
    name: raw.name,
    tagline: typeof raw.tagline === 'string' ? raw.tagline : '',
    instructions: raw.instructions,
    voice: normaliseVoice(raw as Record<string, unknown>),
    glow: typeof raw.glow === 'string' ? raw.glow : DEFAULT_GLOW,
    avatar: typeof raw.avatar === 'string' ? raw.avatar : DEFAULT_AVATAR_URL,
  };
}

/**
 * Resolve a persona's voice from a stored record, snapped to the HF
 * catalog. Migrates two legacy shapes transparently:
 *   - the per-backend `voices: { huggingface, openai }` object (we keep
 *     the HF id), and
 *   - even older single-`voice` string records.
 */
function normaliseVoice(raw: Record<string, unknown>): string {
  if (typeof raw.voice === 'string') return snapVoice(raw.voice);
  const legacy = raw.voices;
  if (legacy && typeof legacy === 'object') {
    return snapVoice((legacy as Record<string, unknown>).huggingface);
  }
  return snapVoice(undefined);
}
