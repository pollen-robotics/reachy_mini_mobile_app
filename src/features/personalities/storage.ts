/**
 * Personalities persistence layer.
 *
 * Two slots in localStorage:
 *
 *   - `reachyMini.personalities.activeId` (string)
 *       Currently active personality id. Read on every conversation
 *       (re)connect to compose the OpenAI session.
 *
 *   - `reachyMini.personalities.custom` (JSON array)
 *       User-authored personalities. Each entry is a `Personality`
 *       record with `kind: 'custom'` and the `custom:<slug>` id form.
 *
 * Storage failures (private mode, quota, etc.) are swallowed with a
 * single warn log: persistence is a UX nicety, not a correctness
 * requirement, so the app stays usable even when the host browser
 * refuses to store anything.
 */
import { DEFAULT_AVATAR_URL, DEFAULT_GLOW, DEFAULT_PERSONALITY_ID } from './builtin';
import type { Personality } from './types';

const ACTIVE_KEY = 'reachyMini.personalities.activeId';
const CUSTOM_KEY = 'reachyMini.personalities.custom';

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
 * Read the user-authored personalities. Returns an empty array on
 * any failure (missing key, bad JSON, schema drift) so the caller
 * never has to handle a `null` distinct from "no customs yet".
 */
export function readCustomPersonalities(): Personality[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidCustom).map(normaliseCustom);
  } catch (err) {
    console.warn('[personalities] failed to read customs:', err);
    return [];
  }
}

/**
 * Persist the user-authored personalities. Best-effort.
 */
export function writeCustomPersonalities(list: Personality[]): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('[personalities] failed to write customs:', err);
  }
}

/**
 * Shape-check a parsed JSON entry. We deliberately stay lenient: any
 * missing optional field falls back to a default in `normaliseCustom`,
 * but the bare minimum (id + name + instructions) MUST be present
 * otherwise the entry is dropped.
 */
function isValidCustom(value: unknown): value is Partial<Personality> & {
  id: string;
  name: string;
  instructions: string;
} {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.startsWith('custom:') &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    typeof v.instructions === 'string' &&
    v.instructions.length > 0
  );
}

function normaliseCustom(
  raw: Partial<Personality> & { id: string; name: string; instructions: string },
): Personality {
  return {
    id: raw.id,
    kind: 'custom',
    name: raw.name,
    tagline: typeof raw.tagline === 'string' ? raw.tagline : '',
    instructions: raw.instructions,
    voice: typeof raw.voice === 'string' ? raw.voice : '',
    glow: typeof raw.glow === 'string' ? raw.glow : DEFAULT_GLOW,
    avatar: typeof raw.avatar === 'string' ? raw.avatar : DEFAULT_AVATAR_URL,
  };
}
