/**
 * Conversation-language persistence layer.
 *
 * Single localStorage slot:
 *
 *   `reachyMini.conversationLanguage.activeId` (string)
 *       The ISO 639-1 code of the user's preferred conversation
 *       language. Read on every conversation (re)connect so the
 *       system-prompt fragment can nudge the model toward it.
 *
 * Failures (private mode, quota, missing localStorage in test
 * envs, …) are swallowed with a single warn line; the in-memory
 * store stays authoritative for the current session.
 *
 * Validation of the stored value against the catalog happens in
 * the store (`resolveLanguageId`), not here - storage is the dumb
 * key/value boundary.
 */
import { DEFAULT_LANGUAGE_ID } from './catalog';

const ACTIVE_KEY = 'reachyMini.conversationLanguage.activeId';

function safeStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

export function readActiveLanguageRaw(): string {
  const storage = safeStorage();
  if (!storage) return DEFAULT_LANGUAGE_ID;
  try {
    const raw = storage.getItem(ACTIVE_KEY);
    if (raw && raw.trim().length > 0) return raw.trim();
  } catch (err) {
    console.warn('[conversation-language] failed to read active id:', err);
  }
  return DEFAULT_LANGUAGE_ID;
}

export function writeActiveLanguage(id: string): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(ACTIVE_KEY, id);
  } catch (err) {
    console.warn('[conversation-language] failed to write active id:', err);
  }
}
