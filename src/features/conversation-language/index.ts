/**
 * Public surface of the conversation-language feature.
 *
 * Engine-side: `getActiveLanguageId()` + `getLanguagePromptAppendix()`.
 * UI side: `useActiveLanguageId()` / `useActiveLanguageMeta()` +
 *           `setActiveLanguageId()` mutation + the `LANGUAGES`
 *           catalog for the picker menu.
 */
export type { LanguageId, LanguageMeta } from './types';
export {
  DEFAULT_LANGUAGE_ID,
  LANGUAGES,
  getLanguageMeta,
  resolveLanguageId,
} from './catalog';
export {
  getActiveLanguageId,
  getActiveLanguageMeta,
  resetActiveLanguageId,
  setActiveLanguageId,
  subscribe as subscribeConversationLanguage,
  useActiveLanguageId,
  useActiveLanguageMeta,
} from './store';
export { getLanguagePromptAppendix } from './prompt-fragment';
