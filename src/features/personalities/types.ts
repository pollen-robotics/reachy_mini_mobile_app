/**
 * Personality domain types.
 *
 * A personality is the "skin" applied to the conversation:
 *   - `instructions`: system prompt fed to the realtime backend
 *   - `voices`       : one synth voice per realtime backend (Hugging
 *                      Face + OpenAI), resolved by the engine against
 *                      the active backend. There is no manual voice
 *                      picker: built-ins ship a curated pair and the
 *                      generator authors one for custom personas.
 *   - `glow`         : accent colour driving the orb's warm-up states
 *                      (idle / connecting / ready). Mid-conversation
 *                      states (listening / processing / ai-speaking)
 *                      keep their semantic colours so the user can
 *                      still read the engine state at a glance.
 *   - `avatar`       : asset URL imported via Vite, ready to plug into
 *                      an `<img src>`.
 *   - `tagline`      : one-line teaser displayed under the avatar in
 *                      the persona strip.
 *
 * Built-in personalities live in `builtin.ts` and ship with the app.
 * Custom personalities are authored at runtime via the "+" card and
 * persisted to localStorage (`storage.ts`). They reuse the default
 * avatar + glow + voices unless the generator overrides them.
 */

export type PersonalityKind = 'builtin' | 'custom';

/**
 * Per-backend synth voice assignment. Each realtime backend exposes a
 * disjoint voice catalog (HF Qwen3-TTS speakers vs OpenAI realtime
 * voices), so a persona pins one id for each. The engine reads the
 * entry matching the active backend at connection time.
 */
export interface PersonaVoices {
  /** Hugging Face Qwen3-TTS speaker id (e.g. `Aiden`). */
  huggingface: string;
  /** OpenAI realtime voice id (e.g. `cedar`). */
  openai: string;
}

export interface Personality {
  /** Stable identifier. Built-in: `builtin:<slug>`. Custom: `custom:<slug>`. */
  id: string;
  /** Whether the personality ships with the app or was authored at
   *  runtime. Drives editability + the `Yours` section in the picker. */
  kind: PersonalityKind;
  /** Display name. Title-cased, ~20 chars max so it fits under the
   *  strip avatar without truncation. */
  name: string;
  /** One-liner shown as a teaser under the avatar in the strip and
   *  in the create modal preview. */
  tagline: string;
  /** Full system prompt sent to the realtime backend. */
  instructions: string;
  /** One synth voice per realtime backend. The engine picks the entry
   *  matching the active backend; an empty/unknown id falls back to
   *  that backend's default voice. */
  voices: PersonaVoices;
  /** Hex colour used for the orb glow during warm-up states. */
  glow: string;
  /** Vite-imported avatar URL. */
  avatar: string;
}

/**
 * Shape of the data the user supplies when creating a custom
 * personality. Voices / glow are optional - we fall back to the
 * default values when they're absent (the generator fills `voices`;
 * the editor no longer collects them).
 */
export interface CustomPersonalityInput {
  name: string;
  tagline?: string;
  instructions: string;
  voices?: Partial<PersonaVoices>;
  glow?: string;
  /**
   * Avatar image src. Usually a generated-sticker data URI
   * (`data:image/svg+xml;...` or `data:image/png;base64,...`). When
   * omitted on create we fall back to `DEFAULT_AVATAR_URL`; when
   * omitted on update we keep the persona's current avatar.
   */
  avatar?: string;
}
