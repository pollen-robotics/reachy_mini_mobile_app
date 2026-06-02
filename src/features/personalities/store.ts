/**
 * Personalities runtime store.
 *
 * Tiny pub/sub holding:
 *   - the merged catalog (built-in + custom),
 *   - the active personality id.
 *
 * Why a module-level store (and not React state) for the active id:
 *
 *   1. The conversation engine lives outside the React tree (it's
 *      mounted into a detached div by `useRobotSession`). Reading the
 *      active personality from React state would require threading a
 *      ref through several layers; a module-level store lets the
 *      engine pull it lazily on every reconnect.
 *
 *   2. Multiple consumers (the strip widget, the orb tint, the
 *      conversation panel restart effect) need to react to the same
 *      change. A single subject keeps them in sync without prop
 *      drilling.
 *
 *   3. Persistence is colocated with mutation: writes go through
 *      `setActive` / `addCustom` / `removeCustom` which always update
 *      both the in-memory state AND localStorage in lockstep.
 */
import { useSyncExternalStore } from 'react';

import {
  BUILTIN_BY_ID,
  BUILTIN_PERSONALITIES,
  DEFAULT_AVATAR_URL,
  DEFAULT_GLOW,
  DEFAULT_PERSONALITY_ID,
  getDefaultPersonality,
} from './builtin';
import {
  readActivePersonalityId,
  readCustomPersonalities,
  writeActivePersonalityId,
  writeCustomPersonalities,
} from './storage';
import type { CustomPersonalityInput, Personality } from './types';

type Listener = () => void;

interface State {
  customs: Personality[];
  activeId: string;
  /** Catalog snapshot (builtin + customs). Recomputed on every
   *  mutation so consumers can rely on referential equality of the
   *  array to skip work. */
  catalog: Personality[];
}

/**
 * Initial bootstrap: read both slots from localStorage. Validation
 * of `activeId` against the resolved catalog happens here so a stale
 * id (e.g. a custom personality removed in another tab) silently
 * falls back to the default instead of pointing nowhere.
 */
function bootstrapState(): State {
  const customs = readCustomPersonalities();
  const catalog = mergeCatalog(customs);
  const requested = readActivePersonalityId();
  const activeId = catalog.some((p) => p.id === requested)
    ? requested
    : DEFAULT_PERSONALITY_ID;
  return { customs, activeId, catalog };
}

function mergeCatalog(customs: Personality[]): Personality[] {
  return [...BUILTIN_PERSONALITIES, ...customs];
}

let state: State = bootstrapState();
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (err) {
      console.warn('[personalities] listener threw:', err);
    }
  }
}

function update(next: Partial<State>): void {
  state = { ...state, ...next };
  emit();
}

/* ─── Public API ──────────────────────────────────────────────────── */

/**
 * Subscribe to changes. Returns an unsubscribe callback. Used by
 * the React `useSyncExternalStore` adapter and by the engine's
 * conversation panel effect (which restarts the conv when the active
 * id changes mid-session).
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot of the current full state. Stable reference: the same
 *  object is returned until a mutation. */
export function getSnapshot(): State {
  return state;
}

/** Resolve the currently active personality. Falls back to the
 *  default when the id no longer resolves (defensive). */
export function getActivePersonality(): Personality {
  const found = resolvePersonalityById(state.activeId);
  return found ?? getDefaultPersonality();
}

/** Resolve a personality by id. Looks at customs first (allows users
 *  to override a built-in id, though the UI doesn't expose that
 *  today) then falls back to built-ins. Returns null on miss. */
export function resolvePersonalityById(id: string): Personality | null {
  const fromCustom = state.customs.find((p) => p.id === id);
  if (fromCustom) return fromCustom;
  return BUILTIN_BY_ID.get(id) ?? null;
}

/** Switch the active personality. Persists to localStorage in the
 *  same tick so a hard refresh keeps the choice. No-op when the id
 *  is already active. */
export function setActivePersonality(id: string): void {
  if (id === state.activeId) return;
  // Defensive: refuse to switch to an unknown id rather than leaving
  // the user with a broken active state.
  if (!resolvePersonalityById(id)) {
    console.warn(`[personalities] refusing to set unknown active id: ${id}`);
    return;
  }
  writeActivePersonalityId(id);
  update({ activeId: id });
}

/** Add a custom personality. Generates the `custom:<slug>` id from
 *  the input name (lowercased, non-alphanumerics → underscore).
 *  Auto-suffixes a counter when the slug clashes with an existing
 *  custom. Returns the resulting personality. */
export function addCustomPersonality(input: CustomPersonalityInput): Personality {
  const baseSlug = slugify(input.name) || 'custom';
  let slug = baseSlug;
  let counter = 2;
  while (state.customs.some((p) => p.id === `custom:${slug}`)) {
    slug = `${baseSlug}_${counter}`;
    counter += 1;
  }
  const next: Personality = {
    id: `custom:${slug}`,
    kind: 'custom',
    name: input.name.trim(),
    tagline: (input.tagline ?? '').trim(),
    instructions: input.instructions.trim(),
    voice: (input.voice ?? '').trim(),
    glow: input.glow ?? DEFAULT_GLOW,
    avatar: DEFAULT_AVATAR_URL,
  };
  const customs = [...state.customs, next];
  writeCustomPersonalities(customs);
  update({ customs, catalog: mergeCatalog(customs) });
  return next;
}

/** Update an existing custom personality in place. The id is kept
 *  stable on purpose (even when the name changes) so the active
 *  selection and any engine reference stay valid; only the editable
 *  fields and the avatar-preserving record are rewritten. Returns the
 *  updated personality, or null when the id isn't a known custom. */
export function updateCustomPersonality(
  id: string,
  input: CustomPersonalityInput,
): Personality | null {
  if (!id.startsWith('custom:')) return null;
  const idx = state.customs.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const prev = state.customs[idx];
  const next: Personality = {
    ...prev,
    name: input.name.trim(),
    tagline: (input.tagline ?? '').trim(),
    instructions: input.instructions.trim(),
    voice: (input.voice ?? '').trim(),
    glow: input.glow ?? prev.glow ?? DEFAULT_GLOW,
  };
  const customs = [...state.customs];
  customs[idx] = next;
  writeCustomPersonalities(customs);
  update({ customs, catalog: mergeCatalog(customs) });
  return next;
}

/** Remove a custom personality. If it was the active one, fall back
 *  to the default so the engine doesn't end up with a dangling id. */
export function removeCustomPersonality(id: string): void {
  if (!id.startsWith('custom:')) return;
  const customs = state.customs.filter((p) => p.id !== id);
  if (customs.length === state.customs.length) return;
  writeCustomPersonalities(customs);
  const nextActive =
    state.activeId === id ? DEFAULT_PERSONALITY_ID : state.activeId;
  if (nextActive !== state.activeId) writeActivePersonalityId(nextActive);
  update({ customs, catalog: mergeCatalog(customs), activeId: nextActive });
}

/** React hook reading the merged catalog. Re-renders on every store
 *  mutation. */
export function usePersonalitiesCatalog(): ReadonlyArray<Personality> {
  return useSyncExternalStore(subscribe, () => state.catalog);
}

/** React hook reading the currently active personality. Re-renders
 *  whenever the active id (or the resolved catalog) changes. */
export function useActivePersonality(): Personality {
  const id = useSyncExternalStore(subscribe, () => state.activeId);
  // We resolve through `getActivePersonality()` so a stale id (e.g.
  // a custom that was removed in another tab) falls back to the
  // default within the same render.
  void id;
  return getActivePersonality();
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}
