/**
 * Public types for the conversation-language module.
 *
 * The conversation language is a user-selected, app-wide preference
 * that biases the Realtime model toward replying in a specific
 * tongue. It is intentionally a small enumeration rather than a
 * free-form locale string: we ship a curated list of 7 languages,
 * each with hand-written prompt nudges and an emoji flag, so the
 * UI surface and the system-prompt fragment stay in lockstep.
 *
 * `LanguageId` and `LanguageMeta` are the only types meant to leak
 * outside the module. Consumers grab them via the package
 * `index.ts`; internal modules (`store`, `prompt-fragment`, ...)
 * import them directly from this file.
 */

/** Stable, persistable identifier for a supported language. ISO
 *  639-1 lowercase code; matches the value persisted in
 *  localStorage. */
export type LanguageId =
  | 'en'
  | 'fr'
  | 'es'
  | 'de'
  | 'it'
  | 'pt'
  | 'zh';

/** Static metadata for a supported language. Built once at module
 *  load and reused everywhere; nothing in here is reactive. */
export interface LanguageMeta {
  /** Persistable identifier (also the ISO 639-1 code). */
  id: LanguageId;
  /** Emoji flag for compact UI surfaces. Picked to be the most
   *  widely recognisable national flag associated with the
   *  language; for languages spoken across many countries we go
   *  with the one most strongly identified with it in mainstream
   *  iconography (e.g. 🇪🇸 for Spanish, 🇧🇷 for Portuguese - both
   *  intentional product choices, not factual claims about the
   *  language's "primary" country). */
  flag: string;
  /** Endonym (the language's name in itself). Used in the picker
   *  menu so each option looks self-identifying. */
  nameNative: string;
  /** English name. Used in the system prompt fragment - models
   *  follow English language names more reliably than endonyms. */
  nameEnglish: string;
}
