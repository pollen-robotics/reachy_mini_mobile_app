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
  snapVoice,
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
  /**
   * Map of personaId -> generation START timestamp (epoch ms) for
   * avatars (stickers) currently baking in the background. Lets surfaces
   * OUTSIDE the authoring form - the persona band and the picker tiles -
   * show a "cooking" ring while a ~1-minute sticker bakes, since the
   * generation outlives the form that kicked it off.
   *
   * It stores the START TIME (not just a flag) so the cooking donut's
   * fill is anchored to when the generation actually began, NOT to when a
   * given ring component happened to mount - so the progress stays
   * correct across remounts (navigating away from the picker and back,
   * the band re-rendering, etc.).
   *
   * A new Map instance is published on every change so
   * `useSyncExternalStore` consumers re-render. Cleared automatically
   * when the avatar is patched in (`setCustomPersonalityAvatar`) or the
   * persona is removed; the generation owner clears it on failure.
   */
  pendingAvatars: ReadonlyMap<string, number>;
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
  return { customs, activeId, catalog, pendingAvatars: new Map() };
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
    voice: snapVoice(input.voice),
    glow: input.glow ?? DEFAULT_GLOW,
    avatar: input.avatar?.trim() || DEFAULT_AVATAR_URL,
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
    // The editor no longer collects a voice; keep the persona's existing
    // one unless the generator supplied a fresh one.
    voice: input.voice ? snapVoice(input.voice) : prev.voice,
    glow: input.glow ?? prev.glow ?? DEFAULT_GLOW,
    // Only overwrite the avatar when a new one is supplied; an
    // omitted avatar keeps whatever the persona already had (e.g. a
    // previously generated sticker survives an instructions edit).
    avatar: input.avatar?.trim() || prev.avatar,
  };
  const customs = [...state.customs];
  customs[idx] = next;
  writeCustomPersonalities(customs);
  update({ customs, catalog: mergeCatalog(customs) });
  return next;
}

/**
 * Patch ONLY the avatar of an existing custom personality.
 *
 * This exists for the async sticker-avatar flow: the user can submit
 * the create/edit form while a ~1-minute sticker generation is still
 * in flight. We create the persona immediately (with the default
 * avatar) and, when the generation resolves, swap in the result by id
 * - even though the authoring form has already unmounted. Going
 * through the store (rather than React state) is what makes that
 * post-unmount patch safe and persistent.
 *
 * No-op (returns null) when the id isn't a known custom persona, so a
 * persona deleted before its sticker finished generating is handled
 * gracefully.
 */
export function setCustomPersonalityAvatar(
  id: string,
  avatar: string,
): Personality | null {
  if (!id.startsWith('custom:')) return null;
  const trimmed = avatar.trim();
  if (!trimmed) return null;
  const idx = state.customs.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const next: Personality = { ...state.customs[idx], avatar: trimmed };
  const customs = [...state.customs];
  customs[idx] = next;
  writeCustomPersonalities(customs);
  // The avatar has landed - the persona is no longer "cooking".
  update({
    customs,
    catalog: mergeCatalog(customs),
    pendingAvatars: withoutPending(id),
  });
  return next;
}

/**
 * Mark a persona as having an avatar generation in flight. Called by
 * the sticker-avatar flow once it knows which persona the in-flight
 * generation belongs to (the create form adopts the id at submit; the
 * edit form adopts it immediately). No-op if already marked.
 */
export function markAvatarPending(id: string): void {
  // Keep the original start time if already marked, so the donut's fill
  // isn't reset by a redundant re-mark.
  if (state.pendingAvatars.has(id)) return;
  const next = new Map(state.pendingAvatars);
  next.set(id, Date.now());
  update({ pendingAvatars: next });
}

/**
 * Clear the "cooking" flag for a persona. Called by the generation
 * owner when a sticker fails or is cancelled (the success path clears
 * it via `setCustomPersonalityAvatar`). No-op if not marked.
 */
export function clearAvatarPending(id: string): void {
  if (!state.pendingAvatars.has(id)) return;
  update({ pendingAvatars: withoutPending(id) });
}

/** Build a new pending map with `id` removed (immutable so consumers
 *  re-render on the reference change). */
function withoutPending(id: string): ReadonlyMap<string, number> {
  if (!state.pendingAvatars.has(id)) return state.pendingAvatars;
  const next = new Map(state.pendingAvatars);
  next.delete(id);
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
  update({
    customs,
    catalog: mergeCatalog(customs),
    activeId: nextActive,
    pendingAvatars: withoutPending(id),
  });
}

/** React hook reading the merged catalog. Re-renders on every store
 *  mutation. */
export function usePersonalitiesCatalog(): ReadonlyArray<Personality> {
  return useSyncExternalStore(subscribe, () => state.catalog);
}

/** React hook: is this persona's avatar currently being generated?
 *  Drives the "cooking" ring on the band + picker tiles. Returns a
 *  primitive so the `useSyncExternalStore` snapshot stays stable. */
export function useIsAvatarPending(id: string): boolean {
  return useSyncExternalStore(subscribe, () => state.pendingAvatars.has(id));
}

/** React hook: the wall-clock ms at which this persona's avatar bake was
 *  marked pending, or `null` if it isn't baking. Lets a progress cue anchor to
 *  the real elapsed time (surviving remounts) instead of its own mount. */
export function useAvatarPendingSince(id: string): number | null {
  return useSyncExternalStore(
    subscribe,
    () => state.pendingAvatars.get(id) ?? null,
  );
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
