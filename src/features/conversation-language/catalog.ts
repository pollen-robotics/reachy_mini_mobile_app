/**
 * Conversation language catalog.
 *
 * Centralises the 7 languages we ship, their flag emoji, and their
 * native + English names. Imported by:
 *   - the store (for `useActiveLanguage()` + persistence),
 *   - the prompt fragment (system-prompt nudge),
 *   - the UI picker (menu options).
 *
 * Default = English. The picker exposes the seven entries below in
 * the order they appear here, which roughly mirrors the user base
 * we expect for the early demos (English + the European market we
 * target first, with Mandarin as the lone non-Latin script to
 * cover the largest mobile audience by headcount).
 *
 * Adding a language
 * ─────────────────
 * 1. Add an entry below + the matching `LanguageId` literal in
 *    `types.ts`.
 * 2. Run the type-checker - everywhere a `LanguageId` switch lives
 *    (currently only `prompt-fragment.ts` if we ever pivot to a
 *    per-language wording; the generic builder works for any
 *    `LanguageMeta`) will fail and force you to handle the new case.
 * 3. No UI change needed - the picker iterates `LANGUAGES`.
 */
import type { LanguageId, LanguageMeta } from './types';

export const DEFAULT_LANGUAGE_ID: LanguageId = 'en';

export const LANGUAGES: readonly LanguageMeta[] = [
  { id: 'en', flag: '🇬🇧', nameNative: 'English',    nameEnglish: 'English'    },
  { id: 'fr', flag: '🇫🇷', nameNative: 'Français',   nameEnglish: 'French'     },
  { id: 'es', flag: '🇪🇸', nameNative: 'Español',    nameEnglish: 'Spanish'    },
  { id: 'de', flag: '🇩🇪', nameNative: 'Deutsch',    nameEnglish: 'German'     },
  { id: 'it', flag: '🇮🇹', nameNative: 'Italiano',   nameEnglish: 'Italian'    },
  { id: 'pt', flag: '🇵🇹', nameNative: 'Português',  nameEnglish: 'Portuguese' },
  { id: 'zh', flag: '🇨🇳', nameNative: '中文',        nameEnglish: 'Mandarin Chinese' },
] as const;

/**
 * O(1) lookup table built once at module load. Avoids re-scanning
 * `LANGUAGES` on every `getLanguageMeta()` call - the prompt
 * fragment + the UI both hit this on every conv start.
 */
const BY_ID = new Map<LanguageId, LanguageMeta>(
  LANGUAGES.map((entry) => [entry.id, entry]),
);

/**
 * Resolve a `LanguageId` to its metadata. Returns the English
 * entry as a defensive fallback if a caller somehow passes an id
 * not in the catalog (should never happen given the type, but the
 * store reads localStorage which is `string` until we narrow it).
 */
export function getLanguageMeta(id: LanguageId): LanguageMeta {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_LANGUAGE_ID)!;
}

/**
 * Narrow an untrusted `string` to a `LanguageId`, falling back to
 * the default. Used at the storage boundary where the value can
 * be anything (a typo'd localStorage entry, a stale id from a
 * pre-existing install that listed more languages than we ship
 * today, …). Keeps the rest of the module free of `if (!isValid)
 * fallback` boilerplate.
 */
export function resolveLanguageId(raw: string | null | undefined): LanguageId {
  if (!raw) return DEFAULT_LANGUAGE_ID;
  return BY_ID.has(raw as LanguageId) ? (raw as LanguageId) : DEFAULT_LANGUAGE_ID;
}
