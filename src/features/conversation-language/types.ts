/**
 * Public types for the conversation-language module.
 *
 * The conversation language is a user-selected, app-wide preference,
 * sent to the conversation app as its speech language (`language.set`):
 * it pins what the robot listens for and the accent it speaks with.
 * It is intentionally a small enumeration rather than a free-form
 * locale string: a curated list of languages, each with an emoji flag.
 *
 * `LanguageId` and `LanguageMeta` are the only types meant to leak
 * outside the module. Consumers grab them via the package
 * `index.ts`; internal modules (`store`, ...) import them directly
 * from this file.
 */

/** Stable, persistable identifier for a supported language. ISO
 *  639-1 lowercase code, or `auto` to let speech recognition detect
 *  it; matches the value persisted in localStorage. */
export type LanguageId =
  | 'auto'
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
  /** Persistable identifier (the ISO 639-1 code, or `auto`). */
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
  /** English name, for accessibility labels. */
  nameEnglish: string;
}
