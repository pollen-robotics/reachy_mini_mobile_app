/**
 * Conversation-language runtime store.
 *
 * Tiny pub/sub that mirrors the personalities store on purpose -
 * both are read by the same two worlds:
 *
 *   - the conversation engine (outside the React tree, queried
 *     lazily on every reconnect via `getActiveLanguageId()`),
 *   - the UI (`useActiveLanguageId()` hook for the picker, and the
 *     restart effect on the conversation panel).
 *
 * Why a module-level store instead of React state:
 *
 *   1. The engine lives in a detached div managed by
 *      `useRobotSession`; threading the language through props
 *      would force every reconnect path to know about it.
 *
 *   2. Multiple components (picker button label, picker menu
 *      check-mark, conversation panel restart effect) need to
 *      react to the same change. A single subject keeps them
 *      strictly in sync without prop drilling.
 *
 *   3. `setActiveLanguageId` writes both the in-memory state AND
 *      localStorage in the same tick, so a hard refresh keeps the
 *      choice without any rehydration ceremony.
 */
import { useSyncExternalStore } from 'react';

import { DEFAULT_LANGUAGE_ID, getLanguageMeta, resolveLanguageId } from './catalog';
import { readActiveLanguageRaw, writeActiveLanguage } from './storage';
import type { LanguageId, LanguageMeta } from './types';

type Listener = () => void;

let activeId: LanguageId = resolveLanguageId(readActiveLanguageRaw());
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (err) {
      console.warn('[conversation-language] listener threw:', err);
    }
  }
}

/**
 * Subscribe to active-language changes. Returns an unsubscribe
 * callback. Used by the React `useSyncExternalStore` adapter and
 * by the ConversationPanel restart effect.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Read the currently active language id. Stable for the lifetime
 * of the current selection; the value only changes through
 * `setActiveLanguageId`.
 */
export function getActiveLanguageId(): LanguageId {
  return activeId;
}

/** Resolve full metadata (flag, names) for the active language.
 *  Convenience wrapper around `getLanguageMeta` for callers that
 *  only need the id once. */
export function getActiveLanguageMeta(): LanguageMeta {
  return getLanguageMeta(activeId);
}

/**
 * Switch the active conversation language. Persists to
 * localStorage in the same tick. No-op when the id is already
 * active. Unknown ids fall back to the default rather than
 * leaving the store in a half-set state.
 */
export function setActiveLanguageId(id: LanguageId | string): void {
  const next = resolveLanguageId(id);
  if (next === activeId) return;
  activeId = next;
  writeActiveLanguage(next);
  emit();
}

/** Reset to the default language. Mainly useful for tests + a
 *  future "restore defaults" affordance in the settings sheet. */
export function resetActiveLanguageId(): void {
  setActiveLanguageId(DEFAULT_LANGUAGE_ID);
}

/* ─── React hooks ─────────────────────────────────────────────────── */

/** React hook reading the active language id. Re-renders on every
 *  store mutation. */
export function useActiveLanguageId(): LanguageId {
  return useSyncExternalStore(subscribe, getActiveLanguageId);
}

/** React hook reading the full metadata of the active language. */
export function useActiveLanguageMeta(): LanguageMeta {
  const id = useActiveLanguageId();
  return getLanguageMeta(id);
}
