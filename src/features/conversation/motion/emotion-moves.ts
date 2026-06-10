/**
 * Emotion intent vocabulary + resolver.
 *
 * Ported from the conversation app's `play_emotion` rework
 * (pollen-robotics/reachy_mini_conversation_app#398). The idea: the
 * model never picks a raw recorded-move filename. It picks a compact,
 * abstract *emotional intent* (`happy`, `sad`, `no_sad`, ...) and we
 * resolve that intent to one of a handful of curated recorded moves
 * from the `reachy-mini-emotions-library` HF dataset.
 *
 * Why this lives client-side (vs. the daemon doing it):
 *   The mobile app streams recorded moves itself by fetching the move
 *   JSON from the public HF CDN by file stem (see `move-player.ts`).
 *   So the resolver only needs to emit a *stem*; the player fetches it.
 *
 * Difference from the upstream Python:
 *   - The desktop resolves against a live `RECORDED_MOVES.list_moves()`
 *     and returns the first available candidate (deterministic). The
 *     mobile has no live catalog, so we trust the curated mapping (all
 *     stems are verified to exist on the CDN) and pick *randomly* among
 *     an intent's candidates for movement variety - same intent does
 *     not always replay the exact same animation.
 */

/**
 * Compact emotional intents exposed to the model as the `play_emotion`
 * enum. Names are intentionally self-explanatory so the schema needs no
 * per-value description. Mirrors `EMOTION_INTENTS` upstream.
 */
export const EMOTION_INTENTS: readonly string[] = [
  "random",
  "happy",
  "excited",
  "loving",
  "grateful",
  "success",
  "thinking",
  "attentive",
  "confused",
  "uncertain",
  "sad",
  "downcast",
  "lonely",
  "angry",
  "irritated",
  "displeased",
  "disgusted",
  "scared",
  "anxious",
  "surprised",
  "amazed",
  "calming",
  "relief",
  "impatient",
  "embarrassed",
  "bored",
  "tired",
  "sleepy",
  "yes",
  "yes_understanding",
  "no",
  "no_sad",
  "no_excited",
  "no_firm",
  "welcoming",
  "greeting",
  "goodbye",
  "go_away",
  "helpful",
  "dance",
  "electric",
  "dying",
] as const;

// Quality tiers used to build the curated random pool. The model never
// sees these stems; they are only the resolution targets.
const EXCELLENT_MOVES: readonly string[] = [
  "anxiety1",
  "boredom2",
  "dance2",
  "dance3",
  "downcast1",
  "dying1",
  "exhausted1",
  "grateful1",
  "helpful1",
  "loving1",
  "rage1",
  "reprimand1",
  "resigned1",
  "sad1",
  "sad2",
  "scared1",
  "sleep1",
  "surprised1",
  "thoughtful1",
  "welcoming2",
];

const OK_CLEAR_MOVES: readonly string[] = [
  "amazed1",
  "attentive1",
  "attentive2",
  "boredom1",
  "confused1",
  "disgusted1",
  "displeased1",
  "displeased2",
  "fear1",
  "impatient2",
  "irritated1",
  "irritated2",
  "laughing1",
  "laughing2",
  "lonely1",
  "no1",
  "no_excited1",
  "no_sad1",
  "reprimand2",
  "shy1",
  "success1",
  "success2",
  "surprised2",
  "thoughtful2",
  "uncertain1",
  "understanding2",
  "yes1",
];

const CURATED_DEFAULT_MOVES: readonly string[] = [
  ...EXCELLENT_MOVES,
  ...OK_CLEAR_MOVES,
];

/**
 * Intent -> ordered curated recorded-move stems. Each stem is a real
 * file in `pollen-robotics/reachy-mini-emotions-library`.
 */
const INTENT_TO_MOVES: Record<string, readonly string[]> = {
  happy: ["laughing2", "laughing1"],
  excited: ["dance3", "dance2"],
  loving: ["loving1"],
  grateful: ["grateful1"],
  success: ["success1", "success2"],
  thinking: ["thoughtful1", "thoughtful2"],
  attentive: ["attentive1", "attentive2"],
  confused: ["confused1"],
  uncertain: ["uncertain1"],
  sad: ["sad1", "sad2", "downcast1"],
  downcast: ["downcast1", "sad1"],
  lonely: ["lonely1"],
  angry: ["rage1", "irritated2", "irritated1"],
  irritated: ["irritated1", "irritated2", "displeased2"],
  displeased: ["displeased1", "displeased2"],
  disgusted: ["disgusted1"],
  scared: ["scared1", "fear1", "anxiety1"],
  anxious: ["anxiety1", "fear1", "scared1"],
  surprised: ["surprised1", "surprised2", "amazed1"],
  amazed: ["amazed1", "surprised1"],
  calming: ["calming1"],
  relief: ["relief1", "relief2"],
  impatient: ["impatient2"],
  embarrassed: ["shy1"],
  bored: ["boredom2", "boredom1"],
  tired: ["exhausted1", "sleep1"],
  sleepy: ["sleep1", "exhausted1"],
  yes: ["yes1", "understanding2"],
  yes_understanding: ["understanding2"],
  no: ["no1"],
  no_sad: ["no_sad1"],
  no_excited: ["no_excited1"],
  no_firm: ["no1"],
  welcoming: ["welcoming2"],
  greeting: ["welcoming2"],
  goodbye: ["loving1", "welcoming2"],
  go_away: ["go_away1"],
  helpful: ["helpful1"],
  dance: ["dance2", "dance3"],
  electric: ["electric1"],
  dying: ["dying1"],
};

// Nuanced yes/no intents recovered from multi-keyword phrases when the
// model passes free text instead of an exact intent.
const KEYWORD_INTENTS: readonly (readonly [readonly string[], string])[] = [
  [["no", "sad"], "no_sad"],
  [["no", "excited"], "no_excited"],
  [["no", "firm"], "no_firm"],
  [["yes", "understanding"], "yes_understanding"],
];

// Stems we accept as a direct exact-id request (curated tiers + every
// stem referenced by an intent).
const ALLOWED_MOVE_NAMES: ReadonlySet<string> = new Set<string>([
  ...CURATED_DEFAULT_MOVES,
  ...Object.values(INTENT_TO_MOVES).flat(),
]);

/** Normalize a request for exact intent and keyword matching. */
function normalizeEmotionKey(value: string): string {
  const withoutAccents = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  return withoutAccents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** First nuanced intent whose keywords are all present. */
function keywordIntent(normalizedKey: string): string | null {
  const tokens = new Set(normalizedKey.split("_"));
  for (const [keywords, intent] of KEYWORD_INTENTS) {
    if (keywords.every((keyword) => tokens.has(keyword))) return intent;
  }
  return null;
}

/** Uniform random pick from a non-empty list. */
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Resolve a request to the ordered list of curated recorded-move stems
 * it maps to (exact curated id, compact intent, or nuanced yes/no
 * phrase). Returns `[]` when nothing fits.
 *
 * Exposed so the caller can both pick a stem to play AND prewarm the
 * siblings: the desktop treats this list as priority/availability
 * fallback, but on mobile every stem exists, so we use the whole list
 * as a variety pool.
 */
export function resolveEmotionCandidates(requested: string): readonly string[] {
  const req = (requested ?? "").trim();
  if (!req) return [];

  const normalized = normalizeEmotionKey(req);
  if (!normalized || normalized === "random") return [];

  // Exact recorded-move id, but only if it is one we curate.
  if (ALLOWED_MOVE_NAMES.has(normalized)) return [normalized];

  let intent: string | null = normalized in INTENT_TO_MOVES ? normalized : null;
  if (intent === null) intent = keywordIntent(normalized);
  if (intent === null) return [];

  return INTENT_TO_MOVES[intent] ?? [];
}

/**
 * Resolve a compact intent, nuanced yes/no phrase, or exact curated
 * move id to a single recorded-move stem, picked at random among the
 * curated candidates for variety. Returns `null` when nothing fits
 * (the caller should fall back to {@link randomCuratedEmotionStem}).
 */
export function resolveEmotionStem(requested: string): string | null {
  const candidates = resolveEmotionCandidates(requested);
  if (candidates.length === 0) return null;
  return pick(candidates);
}

/** Random stem from the curated default pool (used as the fallback). */
export function randomCuratedEmotionStem(): string {
  return pick(CURATED_DEFAULT_MOVES);
}
