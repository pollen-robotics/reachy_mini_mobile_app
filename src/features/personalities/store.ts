/**
 * Personalities runtime store.
 *
 * Tiny pub/sub holding:
 *   - the catalog, which the robot owns,
 *   - the active personality id,
 *   - the authoring the robot has not heard yet.
 *
 * The robot is the source of truth: `cacheCatalog` adopts what it reports at
 * every conversation start. localStorage is a cache, so the picker can draw
 * something before the first conversation of a session, and a queue, because
 * the personality editor is reachable while the conversation app is stopped.
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
  readCachedCatalog,
  readPendingWrites,
  readSeeded,
  takeLegacyCustomPersonalities,
  writeActivePersonalityId,
  writeCachedCatalog,
  writePendingWrites,
  writeSeeded,
} from './storage';
import type { PendingWrites } from './storage';
import type { RobotPersonality } from '@/features/conv-app/client';
import { getLiveClient } from '@/features/conv-app/live-client';

import { ROBOT_DEFAULT_PROFILE, USER_PREFIX, presentationKey, toCatalog } from './from-robot';
import type { CustomPersonalityInput, Personality } from './types';

type Listener = () => void;

interface State {
  /** The robot's catalog, plus any authoring it has not heard yet.
   *  Recomputed on every mutation so consumers can rely on referential
   *  equality of the array to skip work. */
  catalog: Personality[];
  activeId: string;
  /** Authoring queued for the next conversation start. */
  pending: PendingWrites;
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
 * Initial bootstrap from localStorage: the last catalog a robot reported,
 * the active id, and anything still waiting to be pushed. The active id is
 * not validated here; `cacheCatalog` reconciles it against the real catalog
 * as soon as a robot answers.
 */
function bootstrapState(): State {
  const cached = readCachedCatalog();
  const pending = readPendingWrites();
  const base = cached.length > 0 ? cached : [...BUILTIN_PERSONALITIES];

  // Personalities the user wrote back when the phone owned them. They are
  // renamed into the robot's namespace and queued, so the next conversation
  // start moves them where every other personality now lives.
  const rescued = takeLegacyCustomPersonalities()
    .map(persona => ({ ...persona, id: `${USER_PREFIX}${legacySlug(persona.id)}` }))
    .filter(persona => !base.some(known => known.id === persona.id));
  if (rescued.length === 0) {
    return { catalog: base, activeId: readActivePersonalityId(), pending, pendingAvatars: new Map() };
  }

  const catalog = [...base, ...rescued];
  const restored: PendingWrites = {
    dirty: [...pending.dirty, ...rescued.map(persona => persona.id)],
    deleted: pending.deleted,
  };
  writeCachedCatalog(catalog);
  writePendingWrites(restored);
  return {
    catalog,
    activeId: readActivePersonalityId(),
    pending: restored,
    pendingAvatars: new Map(),
  };
}

/** `custom:night_owl` → `night_owl`. */
function legacySlug(id: string): string {
  return id.startsWith('custom:') ? id.slice('custom:'.length) : id;
}

/**
 * Adopt the catalog the robot just reported.
 *
 * The robot owns the list, so its entries win by default. What survives is what
 * the robot cannot know: an avatar the phone generated for a profile it ships
 * no drawing for, the order the user dragged the tiles into, and any authoring
 * still queued, which is newer than whatever the robot is reporting. A persona
 * created while the conversation app was stopped is appended rather than
 * dropped, so it stays visible until this same start pushes it.
 */
export function cacheCatalog(fromRobot: readonly RobotPersonality[]): void {
  const previous = new Map(state.catalog.map(p => [p.id, p]));
  const adopted = toCatalog(fromRobot)
    .filter(p => !state.pending.deleted.includes(p.id))
    .map(p =>
      // An edit the robot has not heard yet is newer than what it reports,
      // so it survives being adopted over.
      state.pending.dirty.includes(p.id)
        ? (previous.get(p.id) ?? p)
        : reuseLocalLook(p, previous.get(p.id))
    );
  const unpushed = state.catalog.filter(
    p => state.pending.dirty.includes(p.id) && !adopted.some(a => a.id === p.id)
  );
  const catalog = inLocalOrder([...adopted, ...unpushed, ...missingBundled(adopted)]);
  if (catalog.length === 0) return;

  // A selection survives the personality being renamed under it: the phone's
  // `builtin:zen_guide` and the robot's `user_personalities/zen_guide` are the
  // same choice. Only a personality that is really gone falls back.
  const activeId =
    catalog.find(p => p.id === state.activeId)?.id ??
    catalog.find(p => presentationKey(p.id) === presentationKey(state.activeId))?.id ??
    catalog.find(p => p.id === ROBOT_DEFAULT_PROFILE)?.id ??
    catalog[0].id;
  writeCachedCatalog(catalog);
  if (activeId !== state.activeId) writeActivePersonalityId(activeId);
  update({ catalog, activeId });
}

/**
 * The bundled personalities this robot has never been offered.
 *
 * The phone shipped sixteen; a stock robot has fourteen, and five of the
 * phone's have no profile there at all. Left alone they would simply vanish
 * the first time the robot's catalog was adopted, taking a personality the
 * user may have been talking to every day. So they are handed to the robot
 * once, as personalities the user owns: from then on the robot is the only
 * source, and deleting one there keeps it deleted.
 */
function missingBundled(adopted: Personality[]): Personality[] {
  if (seeded) return [];
  seeded = true;
  writeSeeded();
  const known = new Set(adopted.map(p => presentationKey(p.id)));
  const missing = BUILTIN_PERSONALITIES.filter(p => !known.has(presentationKey(p.id))).map(p => ({
    ...p,
    id: `${USER_PREFIX}${presentationKey(p.id)}`,
    kind: 'custom' as const,
  }));
  if (missing.length > 0) {
    const pending: PendingWrites = {
      dirty: [...state.pending.dirty, ...missing.map(p => p.id)],
      deleted: state.pending.deleted,
    };
    writePendingWrites(pending);
    state = { ...state, pending };
  }
  return missing;
}

/**
 * Keep the avatar the phone generated for a profile it ships no drawing for.
 * The robot stores its own SVG, but the phone never downloads it, so without
 * this a generated sticker would be replaced by the placeholder on reconnect.
 */
function reuseLocalLook(next: Personality, cached: Personality | undefined): Personality {
  if (!cached || next.avatar !== getDefaultPersonality().avatar) return next;
  return { ...next, avatar: cached.avatar, glow: cached.glow };
}

/** Restore the tile order the user dragged, appending anything new. */
function inLocalOrder(list: Personality[]): Personality[] {
  const rank = new Map(state.catalog.map((p, index) => [p.id, index]));
  return [...list].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  );
}

/** The active id as the robot names it, for `personalities.apply`. */
export function getActivePersonalityId(): string {
  return state.activeId;
}

/** Authoring the robot has not heard yet. Drained by `syncPersonalitiesToRobot`. */
export function getPendingWrites(): PendingWrites {
  return state.pending;
}

/** Forget pushed authoring. Ids still failing stay queued for the next start. */
export function clearPendingWrites(pushed: PendingWrites): void {
  const pending: PendingWrites = {
    dirty: state.pending.dirty.filter(id => !pushed.dirty.includes(id)),
    deleted: state.pending.deleted.filter(id => !pushed.deleted.includes(id)),
  };
  writePendingWrites(pending);
  update({ pending });
}

/** Queue an id for `personalities.save` at the next conversation start. */
function markDirty(id: string): void {
  if (state.pending.dirty.includes(id)) return;
  const pending: PendingWrites = {
    dirty: [...state.pending.dirty, id],
    deleted: state.pending.deleted.filter(deleted => deleted !== id),
  };
  writePendingWrites(pending);
  update({ pending });
}

/** Queue an id for `personalities.delete`, dropping any unpushed save. */
function markDeleted(id: string): void {
  const pending: PendingWrites = {
    dirty: state.pending.dirty.filter(dirty => dirty !== id),
    deleted: state.pending.deleted.includes(id)
      ? state.pending.deleted
      : [...state.pending.deleted, id],
  };
  writePendingWrites(pending);
  update({ pending });
}

/** Replace one entry in the catalog, persisting the new snapshot. */
function replaceInCatalog(catalog: Personality[]): void {
  writeCachedCatalog(catalog);
  update({ catalog });
}

/** Mirrors the stored flag, so the offer is one-shot within a run too. */
let seeded = readSeeded();

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

/** Resolve a personality by id. The robot's catalog wins; the bundled
 *  set is the fallback before the first conversation of a session.
 *  Returns null on miss. */
export function resolvePersonalityById(id: string): Personality | null {
  return state.catalog.find(p => p.id === id) ?? BUILTIN_BY_ID.get(id) ?? null;
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
  // Tell the robot now when it is listening; otherwise the next conversation
  // start carries it (see `sync-settings.ts`).
  getLiveClient()
    ?.applyPersonality(id)
    .catch((err: unknown) => {
      console.warn('[personalities] could not apply on the robot:', err);
    });
}

/** Add a custom personality. Its id is the robot's own naming for what
 *  a user wrote, `user_personalities/<slug>`, derived from the input
 *  name (lowercased, non-alphanumerics → underscore) and auto-suffixed
 *  with a counter on a clash. It lands on the robot at the next
 *  conversation start. Returns the resulting personality. */
export function addCustomPersonality(input: CustomPersonalityInput): Personality {
  const baseSlug = slugify(input.name) || 'custom';
  let slug = baseSlug;
  let counter = 2;
  while (state.catalog.some(p => p.id === `${USER_PREFIX}${slug}`)) {
    slug = `${baseSlug}_${counter}`;
    counter += 1;
  }
  const next: Personality = {
    id: `${USER_PREFIX}${slug}`,
    kind: 'custom',
    name: input.name.trim(),
    tagline: (input.tagline ?? '').trim(),
    instructions: input.instructions.trim(),
    voice: snapVoice(input.voice),
    glow: input.glow ?? DEFAULT_GLOW,
    avatar: input.avatar?.trim() || DEFAULT_AVATAR_URL,
  };
  replaceInCatalog([...state.catalog, next]);
  markDirty(next.id);
  return next;
}

/** Update an existing custom personality in place. The id is kept
 *  stable on purpose (even when the name changes) so the active
 *  selection and any engine reference stay valid; only the editable
 *  fields and the avatar-preserving record are rewritten. Returns the
 *  updated personality, or null when the id isn't a known custom. */
export function updateCustomPersonality(
  id: string,
  input: CustomPersonalityInput
): Personality | null {
  const idx = state.catalog.findIndex(p => p.id === id && p.kind === 'custom');
  if (idx === -1) return null;
  const prev = state.catalog[idx];
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
  const catalog = [...state.catalog];
  catalog[idx] = next;
  replaceInCatalog(catalog);
  markDirty(id);
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
export function setCustomPersonalityAvatar(id: string, avatar: string): Personality | null {
  const trimmed = avatar.trim();
  if (!trimmed) return null;
  const idx = state.catalog.findIndex(p => p.id === id && p.kind === 'custom');
  if (idx === -1) return null;
  const next: Personality = { ...state.catalog[idx], avatar: trimmed };
  const catalog = [...state.catalog];
  catalog[idx] = next;
  writeCachedCatalog(catalog);
  // The avatar is the phone's own drawing, so it stays here: the robot
  // has its own and never asked for this one.
  update({ catalog, pendingAvatars: withoutPending(id) });
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

/**
 * Reorder the custom personalities to match `orderedIds` (STORAGE
 * order, i.e. the order persisted to localStorage - the picker rail
 * displays customs reversed, newest first, and does that mapping
 * itself). Refuses (no-op) unless `orderedIds` is an exact permutation
 * of the current custom ids, so a stale drag result can never drop or
 * duplicate a persona.
 */
export function reorderCustomPersonalities(orderedIds: string[]): void {
  const customs = state.catalog.filter(p => p.kind === 'custom');
  if (orderedIds.length !== customs.length) return;
  const byId = new Map(customs.map(p => [p.id, p]));
  const reordered: Personality[] = [];
  for (const id of orderedIds) {
    const persona = byId.get(id);
    if (!persona) {
      console.warn(`[personalities] refusing reorder with unknown id: ${id}`);
      return;
    }
    byId.delete(id);
    reordered.push(persona);
  }
  const next = state.catalog.map(p =>
    p.kind === 'custom' ? (reordered.shift() as Personality) : p
  );
  replaceInCatalog(next);
}

/** Remove a custom personality, on the phone now and on the robot at the
 *  next conversation start. If it was the active one, fall back to the
 *  default so the engine doesn't end up with a dangling id. */
export function removeCustomPersonality(id: string): void {
  const catalog = state.catalog.filter(p => p.id !== id || p.kind !== 'custom');
  if (catalog.length === state.catalog.length) return;
  writeCachedCatalog(catalog);
  const nextActive =
    state.activeId === id
      ? (catalog.find(p => p.id === ROBOT_DEFAULT_PROFILE)?.id ?? DEFAULT_PERSONALITY_ID)
      : state.activeId;
  if (nextActive !== state.activeId) writeActivePersonalityId(nextActive);
  update({ catalog, activeId: nextActive, pendingAvatars: withoutPending(id) });
  markDeleted(id);
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
  return useSyncExternalStore(subscribe, () => state.pendingAvatars.get(id) ?? null);
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
