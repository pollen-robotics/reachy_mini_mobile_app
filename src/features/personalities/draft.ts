/**
 * Persona authoring "draft" channel.
 *
 * A tiny pub/sub that lets the create/edit FORM publish the persona it's
 * authoring (live name, avatar preview, cooking flag, and a regenerate
 * callback) so the persistent personality BAND above it can mirror that
 * persona in real time.
 *
 * Why a module-level store rather than props: the band
 * (`PersonalityPill`) and the form (`CreatePersonalityModal`) are
 * siblings in the host (`ConversationPanel`), not parent/child. Threading
 * the form's live state up to the host and back down to the band would
 * mean lifting the form's `name` state + the sticker hook into the host.
 * A small subject keeps the two in sync without that surgery, the same
 * way the active-personality store already does.
 *
 * Contract:
 *   - The form calls `setPersonaDraft(...)` whenever its name / avatar /
 *     cooking state changes, and `clearPersonaDraft()` on unmount.
 *   - The band reads `usePersonaDraft()` while a form is open and uses it
 *     to drive its title, avatar disc, cooking ring, and (edit only) the
 *     regenerate badge.
 *
 * The avatar is shown ONLY here (the band) - never inside the form body -
 * so there's a single, stable place for the persona's face + its
 * regenerate control while authoring.
 */
import { useSyncExternalStore } from 'react';

export interface PersonaDraft {
  /** Live name as typed in the form (may be empty while authoring). */
  name: string;
  /** Avatar to show: a freshly generated sticker, or the persona's
   *  existing avatar in edit mode. `null` when there's nothing to show
   *  yet (the common create case). */
  avatar: string | null;
  /** True while a sticker is baking for this draft. */
  cooking: boolean;
  /** Regenerate the avatar (edit mode only). `null` when regeneration
   *  isn't available (create mode authors the avatar passively at
   *  submit, so there's nothing to regenerate yet). */
  regenerate: (() => void) | null;
}

let draft: PersonaDraft | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (err) {
      console.warn('[persona-draft] listener threw:', err);
    }
  }
}

/** Publish (or replace) the current authoring draft. */
export function setPersonaDraft(next: PersonaDraft): void {
  draft = next;
  emit();
}

/** Clear the draft (form closed). No-op when already empty. */
export function clearPersonaDraft(): void {
  if (draft === null) return;
  draft = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook reading the current authoring draft (or `null`). */
export function usePersonaDraft(): PersonaDraft | null {
  return useSyncExternalStore(subscribe, () => draft);
}
