/**
 * Plutchik mapping of the `pollen-robotics/reachy-mini-emotions-library`
 * dataset - ported verbatim (data + helpers) from the Emotions Space
 * (`pollen-robotics/emotions`, `src/data/plutchik.ts`) so the mobile
 * wheel and the Space group moves identically. Keep the two in sync when
 * the dataset grows.
 *
 * Original header:
 * Manual Plutchik mapping of the 79 emotions in the
 * `pollen-robotics/reachy-mini-emotions-library` dataset.
 *
 * Plutchik's wheel of emotions defines 8 primary families (joy, trust,
 * fear, surprise, sadness, disgust, anger, anticipation) arranged
 * radially, each split into 3 intensity rings (mild → strong). We
 * mirror that taxonomy here so the in-app wheel can group the dataset
 * naturally.
 *
 * Why hand-curated, not algorithmic? The dataset is small (79 items)
 * but each emotion name is ambiguous (e.g. `electric1`, `dance3`,
 * `lost1`) - a string-only classifier would routinely misfile them.
 * A human pass takes 30 minutes and produces a much cleaner UX.
 *
 * Conventions:
 *   - `family`     : one of the 8 Plutchik primaries.
 *   - `intensity`  : 1 (mild outer ring), 2 (mid ring), 3 (strong inner).
 *                    Following Plutchik's diagram, where the innermost
 *                    ring is the most intense form.
 *   - `emoji`      : taken from the desktop app's `EMOTION_EMOJIS`
 *                    map. We re-export the ones we use here so the
 *                    emotions Space stays self-contained.
 *   - `label`      : human-readable, lower-case ("happy", "scared").
 *   - `description`: short copy used in the bottom sheet card.
 *
 * If a future dataset entry doesn't fit any Plutchik family (e.g.
 * dances, neutral motions), we route it to the SPECIAL bucket which
 * the wheel renders as a 9th outer ring rather than mis-categorising
 * it into a primary.
 */

/** HF dataset the moves (and their sounds) live in. */
export const EMOTIONS_DATASET = 'pollen-robotics/reachy-mini-emotions-library';

export type PlutchikFamily =
  | 'joy'
  | 'trust'
  | 'fear'
  | 'surprise'
  | 'sadness'
  | 'disgust'
  | 'anger'
  | 'anticipation';

/**
 * Special bucket for moves that are not Plutchik emotions but still
 * live in the `reachy-mini-emotions-library` dataset (canned dances,
 * neutral signals like `yes1` / `no1`, sleep, etc). The wheel does
 * NOT render this family; it gets a separate "Other" tab at the
 * bottom of the bottom sheet.
 */
export const SPECIAL = 'special' as const;
export type Family = PlutchikFamily | typeof SPECIAL;

export interface EmotionDef {
  /**
   * Stable id - matches the file name in the HF dataset (without
   * extension). Used for `/<id>.json` lookups and for the
   * `(daemon endpoint)`/api/move/play/recorded-move-dataset/<dataset>/<id>`
   * fallback if we ever wire that up.
   */
  id: string;
  family: Family;
  /** 1 = mild outer ring, 3 = strong inner ring. Ignored for SPECIAL. */
  intensity: 1 | 2 | 3;
  emoji: string;
  label: string;
  description: string;
}

/**
 * Plutchik colour palette, designed to land somewhere between Plutchik's
 * original (saturated primaries) and a modern UI palette (muted, dark-
 * mode safe). All colours hit AAA contrast against `--surface-bg`
 * tokens in `theme.ts`.
 */
export const FAMILY_COLORS: Record<PlutchikFamily, string> = {
  joy: '#FFD93D', // warm yellow
  trust: '#7ED957', // soft green
  fear: '#1B9E77', // teal-green (fear in Plutchik original is deep green)
  surprise: '#0FB7D6', // cyan
  sadness: '#5B5BD6', // indigo
  disgust: '#A47FE3', // violet
  anger: '#E5484D', // crimson red
  anticipation: '#FF8A00', // amber
};

export const FAMILY_LABELS: Record<PlutchikFamily, string> = {
  joy: 'Joy',
  trust: 'Trust',
  fear: 'Fear',
  surprise: 'Surprise',
  sadness: 'Sadness',
  disgust: 'Disgust',
  anger: 'Anger',
  anticipation: 'Anticipation',
};

export const FAMILY_EMOJIS: Record<PlutchikFamily, string> = {
  joy: '😊',
  trust: '🙏',
  fear: '😨',
  surprise: '😲',
  sadness: '😢',
  disgust: '🤢',
  anger: '😠',
  anticipation: '🤔',
};

/**
 * Display order on the wheel, clockwise starting from the top
 * (12 o'clock). Matches Plutchik's classical diagram orientation.
 */
export const FAMILY_ORDER: readonly PlutchikFamily[] = [
  'joy',
  'trust',
  'fear',
  'surprise',
  'sadness',
  'disgust',
  'anger',
  'anticipation',
];

/**
 * The 79 emotions of the dataset, manually mapped.
 *
 * Sources of truth used for classification:
 *  - the english label (`loving` → joy, `irritated` → anger),
 *  - the desktop app's `EMOTION_EMOJIS` (kept consistent here),
 *  - the daemon's recorded trajectories (where the name was
 *    ambiguous, we erred on the side of the strongest match).
 */
export const EMOTIONS: readonly EmotionDef[] = [
  // ─── JOY ───
  { id: 'cheerful1', family: 'joy', intensity: 1, emoji: '😊', label: 'cheerful', description: 'a bright, casual smile' },
  { id: 'loving1', family: 'joy', intensity: 2, emoji: '🥰', label: 'loving', description: 'tender, affectionate gaze' },
  { id: 'laughing1', family: 'joy', intensity: 3, emoji: '😂', label: 'laughing', description: 'tears-of-joy laughter' },
  { id: 'laughing2', family: 'joy', intensity: 3, emoji: '🤣', label: 'laughing (rolling)', description: 'rolling-on-the-floor laughter' },
  { id: 'amazed1', family: 'joy', intensity: 2, emoji: '🤩', label: 'amazed', description: 'starstruck wonder' },
  { id: 'enthusiastic1', family: 'joy', intensity: 2, emoji: '🎊', label: 'enthusiastic', description: 'celebratory cheer' },
  { id: 'enthusiastic2', family: 'joy', intensity: 3, emoji: '🥳', label: 'enthusiastic (party)', description: 'full party-mode joy' },
  { id: 'success1', family: 'joy', intensity: 2, emoji: '✨', label: 'success', description: 'a sparkly little win' },
  { id: 'success2', family: 'joy', intensity: 2, emoji: '🌟', label: 'success (glow)', description: 'a glowing achievement' },
  { id: 'proud1', family: 'joy', intensity: 1, emoji: '😎', label: 'proud (cool)', description: 'cool & quietly proud' },
  { id: 'proud2', family: 'joy', intensity: 2, emoji: '🏆', label: 'proud (winner)', description: 'triumphant, trophy-style' },
  { id: 'proud3', family: 'joy', intensity: 2, emoji: '💪', label: 'proud (strong)', description: 'flexed, accomplished' },
  { id: 'electric1', family: 'joy', intensity: 3, emoji: '⚡', label: 'electric', description: 'high-voltage excitement' },

  // ─── TRUST ───
  { id: 'welcoming1', family: 'trust', intensity: 1, emoji: '👋', label: 'welcoming', description: 'a friendly hello wave' },
  { id: 'welcoming2', family: 'trust', intensity: 2, emoji: '🤗', label: 'welcoming (hug)', description: 'open-arms welcome' },
  { id: 'helpful1', family: 'trust', intensity: 1, emoji: '🙋', label: 'helpful', description: 'I can help with that' },
  { id: 'helpful2', family: 'trust', intensity: 2, emoji: '🤝', label: 'helpful (handshake)', description: 'a reassuring handshake' },
  { id: 'grateful1', family: 'trust', intensity: 2, emoji: '🙏', label: 'grateful', description: 'sincere thank-you' },
  { id: 'understanding1', family: 'trust', intensity: 2, emoji: '💡', label: 'understanding', description: 'a-ha, I get it' },
  { id: 'understanding2', family: 'trust', intensity: 2, emoji: '🤝', label: 'understanding (mutual)', description: 'we-are-on-the-same-page' },
  { id: 'come1', family: 'trust', intensity: 1, emoji: '🫴', label: 'come over', description: 'come closer, palm-up beckon' },
  { id: 'serenity1', family: 'trust', intensity: 1, emoji: '🧘', label: 'serenity', description: 'a calm, centred pause' },
  { id: 'calming1', family: 'trust', intensity: 1, emoji: '☮️', label: 'calming', description: 'gentle, reassuring breaths' },
  { id: 'relief1', family: 'trust', intensity: 1, emoji: '😌', label: 'relief', description: 'phew, tension lifted' },
  { id: 'relief2', family: 'trust', intensity: 1, emoji: '😮‍💨', label: 'relief (exhale)', description: 'a deep relieved exhale' },

  // ─── FEAR ───
  { id: 'anxiety1', family: 'fear', intensity: 1, emoji: '😟', label: 'anxiety', description: 'low-grade worry' },
  { id: 'fear1', family: 'fear', intensity: 2, emoji: '😨', label: 'fear', description: 'classic startled fear' },
  { id: 'scared1', family: 'fear', intensity: 3, emoji: '😱', label: 'scared', description: 'screaming, full-on scare' },
  { id: 'shy1', family: 'fear', intensity: 1, emoji: '😳', label: 'shy', description: 'flushed, looking away' },
  { id: 'uncomfortable1', family: 'fear', intensity: 1, emoji: '😬', label: 'uncomfortable', description: 'awkward grimace' },
  { id: 'oops1', family: 'fear', intensity: 1, emoji: '🫣', label: 'oops', description: 'peeking-through-fingers oops' },
  { id: 'oops2', family: 'fear', intensity: 1, emoji: '😅', label: 'oops (sweat)', description: 'nervous sweat-smile' },
  { id: 'lost1', family: 'fear', intensity: 2, emoji: '😵‍💫', label: 'lost', description: 'dizzy, disoriented' },
  { id: 'dying1', family: 'fear', intensity: 3, emoji: '😵', label: 'dying', description: 'dramatically defeated' },

  // ─── SURPRISE ───
  { id: 'surprised1', family: 'surprise', intensity: 2, emoji: '😲', label: 'surprised', description: 'astonished double-take' },
  { id: 'surprised2', family: 'surprise', intensity: 1, emoji: '😯', label: 'surprised (hushed)', description: 'a quiet, hushed whoa' },
  { id: 'confused1', family: 'surprise', intensity: 1, emoji: '😕', label: 'confused', description: 'wait, what?' },
  { id: 'incomprehensible2', family: 'surprise', intensity: 2, emoji: '🤷', label: 'incomprehensible', description: 'shrug, no clue' },
  { id: 'uncertain1', family: 'surprise', intensity: 1, emoji: '🤨', label: 'uncertain', description: 'sceptical eyebrow raise' },

  // ─── SADNESS ───
  { id: 'downcast1', family: 'sadness', intensity: 1, emoji: '😔', label: 'downcast', description: 'pensive, head down' },
  { id: 'lonely1', family: 'sadness', intensity: 2, emoji: '🥺', label: 'lonely', description: 'pleading puppy eyes' },
  { id: 'resigned1', family: 'sadness', intensity: 2, emoji: '😞', label: 'resigned', description: 'disappointed but accepting' },
  { id: 'sad2', family: 'sadness', intensity: 2, emoji: '😢', label: 'sad', description: 'a single quiet tear' },
  { id: 'sad1', family: 'sadness', intensity: 3, emoji: '😭', label: 'sad (loud)', description: 'big, full-body sob' },
  { id: 'yes_sad1', family: 'sadness', intensity: 2, emoji: '🥹', label: 'sad yes', description: 'holding back tears' },
  { id: 'no_sad1', family: 'sadness', intensity: 2, emoji: '😥', label: 'sad no', description: 'sad-but-relieved no' },
  { id: 'tired1', family: 'sadness', intensity: 1, emoji: '😴', label: 'tired', description: 'gentle, sleepy fade' },
  { id: 'exhausted1', family: 'sadness', intensity: 2, emoji: '😩', label: 'exhausted', description: 'completely worn out' },
  { id: 'sleep1', family: 'sadness', intensity: 1, emoji: '💤', label: 'sleep', description: 'drifting off to sleep' },
  { id: 'boredom1', family: 'sadness', intensity: 1, emoji: '🥱', label: 'bored', description: 'a yawning kind of bored' },
  { id: 'boredom2', family: 'sadness', intensity: 1, emoji: '😑', label: 'bored (flat)', description: 'flat, unimpressed' },

  // ─── DISGUST ───
  { id: 'disgusted1', family: 'disgust', intensity: 2, emoji: '🤢', label: 'disgusted', description: 'visibly nauseated' },
  { id: 'displeased1', family: 'disgust', intensity: 1, emoji: '😒', label: 'displeased', description: 'unimpressed side-eye' },
  { id: 'displeased2', family: 'disgust', intensity: 1, emoji: '😑', label: 'displeased (flat)', description: 'cold, flat displeasure' },
  { id: 'contempt1', family: 'disgust', intensity: 2, emoji: '🙄', label: 'contempt', description: 'classic eye-roll' },
  { id: 'indifferent1', family: 'disgust', intensity: 1, emoji: '😐', label: 'indifferent', description: 'neutral, unbothered' },
  { id: 'go_away1', family: 'disgust', intensity: 2, emoji: '👉', label: 'go away', description: 'go in that direction' },

  // ─── ANGER ───
  { id: 'irritated1', family: 'anger', intensity: 1, emoji: '😠', label: 'irritated', description: 'mild annoyance' },
  { id: 'irritated2', family: 'anger', intensity: 1, emoji: '😤', label: 'irritated (steam)', description: 'steam-from-nose annoyance' },
  { id: 'frustrated1', family: 'anger', intensity: 2, emoji: '😫', label: 'frustrated', description: 'tired-and-frustrated' },
  { id: 'impatient1', family: 'anger', intensity: 1, emoji: '⏳', label: 'impatient', description: 'tapping foot, hurrying you' },
  { id: 'impatient2', family: 'anger', intensity: 1, emoji: '🙄', label: 'impatient (eye-roll)', description: 'come-on eye-roll' },
  { id: 'rage1', family: 'anger', intensity: 3, emoji: '😡', label: 'rage', description: 'red-face anger' },
  { id: 'furious1', family: 'anger', intensity: 3, emoji: '🤬', label: 'furious', description: 'unprintable fury' },
  { id: 'reprimand1', family: 'anger', intensity: 2, emoji: '😤', label: 'reprimand', description: 'stern disapproval' },
  { id: 'reprimand2', family: 'anger', intensity: 2, emoji: '😡', label: 'reprimand (angry)', description: 'angrier reprimand' },
  { id: 'reprimand3', family: 'anger', intensity: 3, emoji: '🚫', label: 'reprimand (no!)', description: 'absolute no, prohibited' },
  { id: 'no1', family: 'anger', intensity: 1, emoji: '👎', label: 'no', description: 'a clear, firm no' },
  { id: 'no_excited1', family: 'anger', intensity: 2, emoji: '🙅', label: 'no (emphatic)', description: 'arms-crossed emphatic no' },

  // ─── ANTICIPATION ───
  { id: 'thoughtful1', family: 'anticipation', intensity: 1, emoji: '🤔', label: 'thoughtful', description: 'pondering, hand on chin' },
  { id: 'thoughtful2', family: 'anticipation', intensity: 1, emoji: '💭', label: 'thoughtful (bubble)', description: 'lost in thought' },
  { id: 'curious1', family: 'anticipation', intensity: 1, emoji: '🧐', label: 'curious', description: 'monocle inspection' },
  { id: 'inquiring1', family: 'anticipation', intensity: 1, emoji: '❓', label: 'inquiring', description: 'asking a question' },
  { id: 'inquiring2', family: 'anticipation', intensity: 1, emoji: '🔍', label: 'inquiring (search)', description: 'investigative search' },
  { id: 'inquiring3', family: 'anticipation', intensity: 1, emoji: '🤨', label: 'inquiring (raise)', description: 'questioning eyebrow raise' },
  { id: 'attentive1', family: 'anticipation', intensity: 2, emoji: '👂', label: 'attentive', description: 'listening intently' },
  { id: 'attentive2', family: 'anticipation', intensity: 2, emoji: '🦉', label: 'attentive (owl)', description: 'wise, vigilant attention' },
  { id: 'yes1', family: 'anticipation', intensity: 1, emoji: '👍', label: 'yes', description: 'confident yes' },

  // ─── SPECIAL (in-library dances) ───
  { id: 'dance1', family: SPECIAL, intensity: 1, emoji: '💃', label: 'dance 1', description: 'a little dance number' },
  { id: 'dance2', family: SPECIAL, intensity: 1, emoji: '🕺', label: 'dance 2', description: 'another groove' },
  { id: 'dance3', family: SPECIAL, intensity: 1, emoji: '🪩', label: 'dance 3', description: 'disco-ball energy' },
];

/** Index emotions by family for fast lookup. */
export const EMOTIONS_BY_FAMILY: Record<Family, EmotionDef[]> = {
  joy: [],
  trust: [],
  fear: [],
  surprise: [],
  sadness: [],
  disgust: [],
  anger: [],
  anticipation: [],
  special: [],
};

for (const e of EMOTIONS) {
  EMOTIONS_BY_FAMILY[e.family].push(e);
}

/**
 * Sort each bucket by intensity (low → high), then by label so the
 * sheet always looks ordered. Done once at module load.
 */
for (const key of Object.keys(EMOTIONS_BY_FAMILY) as Family[]) {
  EMOTIONS_BY_FAMILY[key].sort((a, b) =>
    a.intensity === b.intensity
      ? a.label.localeCompare(b.label)
      : a.intensity - b.intensity,
  );
}

/** Total count per family - used by the wheel for the dot density indicator. */
export const COUNT_BY_FAMILY: Record<Family, number> = {
  joy: EMOTIONS_BY_FAMILY.joy.length,
  trust: EMOTIONS_BY_FAMILY.trust.length,
  fear: EMOTIONS_BY_FAMILY.fear.length,
  surprise: EMOTIONS_BY_FAMILY.surprise.length,
  sadness: EMOTIONS_BY_FAMILY.sadness.length,
  disgust: EMOTIONS_BY_FAMILY.disgust.length,
  anger: EMOTIONS_BY_FAMILY.anger.length,
  anticipation: EMOTIONS_BY_FAMILY.anticipation.length,
  special: EMOTIONS_BY_FAMILY.special.length,
};

/** Lookup by id - used by the player to fetch the right trajectory. */
export const EMOTION_BY_ID: Record<string, EmotionDef> = {};
for (const e of EMOTIONS) {
  EMOTION_BY_ID[e.id] = e;
}

/** Pick a random emotion (excludes SPECIAL). Used by the dice spin. */
export function randomEmotion(): EmotionDef {
  const primary = EMOTIONS.filter((e) => e.family !== SPECIAL);
  return primary[Math.floor(Math.random() * primary.length)]!;
}

/**
 * Pick a random emotion within a single family. Used by the dice
 * spin once the wheel has visually landed on a family - we draw
 * from that family's bucket so the played emotion always matches
 * the slice the wheel stopped on.
 *
 * Falls back to a fully-random pick if the requested family is
 * empty (defensive - the curated dataset always has at least one
 * entry per primary, but the type system can't prove that).
 */
export function randomEmotionFromFamily(family: PlutchikFamily): EmotionDef {
  const bucket = EMOTIONS_BY_FAMILY[family];
  if (!bucket || bucket.length === 0) return randomEmotion();
  return bucket[Math.floor(Math.random() * bucket.length)]!;
}
