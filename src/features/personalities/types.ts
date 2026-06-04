/**
 * Personality domain types.
 *
 * A personality is the "skin" applied to the conversation:
 *   - `instructions`: system prompt fed to the realtime backend
 *   - `voice`        : backend voice id used to synthesize responses
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
 * avatar + glow + voice unless the user overrides them.
 */

export type PersonalityKind = 'builtin' | 'custom';

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
  /** Hugging Face realtime voice id. Empty string falls back to the
   *  engine's `DEFAULT_VOICE`. */
  voice: string;
  /** Hex colour used for the orb glow during warm-up states. */
  glow: string;
  /** Vite-imported avatar URL. */
  avatar: string;
}

/**
 * Shape of the data the user supplies when creating a custom
 * personality. Voice / glow are optional - we fall back to the
 * default values when the user doesn't pick them.
 */
export interface CustomPersonalityInput {
  name: string;
  tagline?: string;
  instructions: string;
  voice?: string;
  glow?: string;
  /**
   * Avatar image src. Usually a generated-sticker data URI
   * (`data:image/svg+xml;...` or `data:image/png;base64,...`). When
   * omitted on create we fall back to `DEFAULT_AVATAR_URL`; when
   * omitted on update we keep the persona's current avatar.
   */
  avatar?: string;
}
