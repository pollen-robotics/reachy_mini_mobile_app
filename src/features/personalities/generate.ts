/**
 * Generate a personality from a one-sentence description.
 *
 * Powers the "magic" entry point in `CreatePersonalityModal`: the user
 * types a vibe ("a grumpy French chef robot who thinks it earned a
 * Michelin star") and we turn it into the four authoring knobs
 * (`name`, `tagline`, `instructions`, `voice`) so they never face a
 * blank system-prompt box.
 *
 * Why this lives next to the data layer (not the UI)
 * --------------------------------------------------
 * It's a pure async function over the personality shape, with no React
 * dependency, so it sits in `features/personalities/` beside
 * `store.ts` / `builtin.ts`. The modal just awaits it and pre-fills its
 * fields from the result.
 *
 * How it talks to a model
 * -----------------------
 * Same transport as the vision module (`vision/providers/hf-vlm-provider.ts`):
 *
 *   - Hugging Face Inference Providers router
 *     (`router.huggingface.co/v1/chat/completions`), OpenAI-compatible.
 *   - Authenticated with the user's OWN HF token, read from the single
 *     source of truth `readHfTokenFromStorage()` (sessionStorage). No
 *     master key on the wire, per-user billing.
 *   - Routed through `@tauri-apps/plugin-http` (`tauriFetch`) so the
 *     call isn't subject to browser CORS enforcement (the router does
 *     not serve `Access-Control-Allow-Origin: *`). The capability is
 *     already pinned to `https://router.huggingface.co/*` in
 *     `src-tauri/capabilities/default.json`.
 *
 * Output contract
 * ---------------
 * We request JSON-schema structured output (`response_format`) so capable
 * providers return a schema-valid object directly - the voice is even
 * constrained to the real `AVAILABLE_VOICES` enum. The router enables this
 * only where a provider advertises support and degrades to a plain request
 * otherwise, so we STILL parse defensively (models love to wrap JSON in prose
 * or ```json fences). The result is validated + clamped to the same limits the
 * manual form enforces, and the voice is snapped to a real `AVAILABLE_VOICES`
 * id so the picker always lands on a selectable chip.
 */

import { readHfTokenFromStorage } from "@/features/conversation/engine/ephemeral-key";
import { AVAILABLE_VOICES } from "./builtin";
import { HfRouterError, routerChatCompletion } from "@/features/hf";

/**
 * Text model used to author personalities. Override via
 * `VITE_PERSONALITY_HF_MODEL` for A/B tests. Defaults to a broadly
 * served instruct model on the HF router; append `:<provider>` /
 * `:fastest` / `:cheapest` to pin a routing policy.
 */
const HF_TEXT_MODEL =
  (import.meta.env?.VITE_PERSONALITY_HF_MODEL as string | undefined) ??
  "Qwen/Qwen2.5-72B-Instruct";

/** Hard wall-time cap on the generation call. Generous vs the vision
 *  poller (this is a one-off, user-initiated request behind a spinner)
 *  but bounded so a stuck provider doesn't hang the button forever. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Field clamps. Mirror the manual form (`CreatePersonalityModal`'s
 *  `NAME_MAX` / `TAGLINE_MAX`) so a generated persona is indistinguishable
 *  from a hand-authored one once it lands in the fields. */
const NAME_MAX = 24;
const TAGLINE_MAX = 60;
const INSTRUCTIONS_MAX = 1200;
const DESCRIPTION_MAX = 240;

/**
 * JSON Schema for structured-output generation. Mirrors the prose contract in
 * `SYSTEM_PROMPT` (and the manual form's clamps) so capable providers return a
 * schema-valid persona directly. `maxLength` matches the clamps below;
 * `voice` is constrained to the real voice ids so the picker always lands on a
 * selectable chip. `additionalProperties: false` keeps replies tight.
 */
const PERSONA_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name", "tagline", "instructions", "voice"],
  properties: {
    name: {
      type: "string",
      maxLength: NAME_MAX,
      description: "Punchy display name in Title Case.",
    },
    tagline: {
      type: "string",
      maxLength: TAGLINE_MAX,
      description: "One playful line describing the vibe.",
    },
    instructions: {
      type: "string",
      maxLength: INSTRUCTIONS_MAX,
      description:
        "System prompt for the persona, using '## IDENTITY', '## RESPONSE RULES', then optional '## QUIRKS'.",
    },
    voice: {
      type: "string",
      enum: [...AVAILABLE_VOICES],
      description: "Voice id matching the persona's energy.",
    },
  },
};

export type GeneratePersonalityReason =
  | "hf_token_missing"
  | "empty_description"
  | "request_failed"
  // The model provider is temporarily overloaded (HTTP 429/503 or a
  // `server_overload` body), even after falling back across the model
  // chain. Transient + retryable, so the UI surfaces a friendly "busy, try
  // again" prompt rather than a generic failure.
  | "overloaded"
  // None of the candidate models is served by a provider the user has
  // enabled on their HF account (HTTP 400 `model_not_supported`). Actionable
  // (enable an Inference Provider) rather than a transient blip.
  | "model_unavailable"
  | "bad_response";

/** Map a low-level router failure to the modal-facing error vocabulary. */
function fromRouterError(err: unknown): GeneratePersonalityError {
  if (err instanceof HfRouterError) {
    const reason: GeneratePersonalityReason = err.overloaded
      ? "overloaded"
      : err.modelUnsupported
        ? "model_unavailable"
        : "request_failed";
    const message = err.overloaded
      ? "the model provider is overloaded right now"
      : err.modelUnsupported
        ? "no enabled HF Inference Provider serves the generation models"
        : err.message;
    return new GeneratePersonalityError(reason, message, err.status || undefined);
  }
  return new GeneratePersonalityError(
    "request_failed",
    `network error reaching HF router: ${(err as Error)?.message ?? "unknown"}`,
  );
}

export class GeneratePersonalityError extends Error {
  readonly reason: GeneratePersonalityReason;
  readonly status?: number;

  constructor(
    reason: GeneratePersonalityReason,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "GeneratePersonalityError";
    this.reason = reason;
    this.status = status;
  }
}

/** The authoring knobs a generation produces. Matches the subset of
 *  `Personality` the create form collects (glow/avatar are not
 *  user-authored in the current UI). */
export interface GeneratedPersonality {
  name: string;
  tagline: string;
  instructions: string;
  voice: string;
}

/**
 * Turn a free-text vibe into a ready-to-edit personality.
 *
 * Throws `GeneratePersonalityError` on every failure path so the modal
 * can branch on `reason` (sign-in prompt vs retry vs generic error).
 */
export async function generatePersonality(
  description: string,
): Promise<GeneratedPersonality> {
  const vibe = description.trim().slice(0, DESCRIPTION_MAX);
  if (!vibe) {
    throw new GeneratePersonalityError(
      "empty_description",
      "describe the personality in a sentence first",
    );
  }
  return runPersonaChat(buildUserPrompt(vibe));
}

/**
 * Invent a wholly original personality with no user input ("surprise
 * me"). We steer the model toward variety with a few randomly drawn
 * "ingredients" (an archetype + a setting + a quirk) so repeated taps
 * don't converge on the same handful of safe personas, then let it run
 * hot (`temperature` in `runPersonaChat`). Same parse/validate/clamp
 * path as `generatePersonality`.
 */
export async function generateRandomPersonality(): Promise<GeneratedPersonality> {
  return runPersonaChat(buildRandomPrompt());
}

/**
 * Shared HF-router round-trip: send the system prompt + a user message,
 * then parse the persona JSON out of the reply. Centralised so the
 * "from a sentence" and "surprise me" entry points share auth, timeout,
 * error mapping, and response parsing.
 */
async function runPersonaChat(
  userPrompt: string,
): Promise<GeneratedPersonality> {
  const hfToken = readHfTokenFromStorage();
  if (!hfToken) {
    throw new GeneratePersonalityError(
      "hf_token_missing",
      "no HF token in sessionStorage; sign in to Hugging Face first",
    );
  }

  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  let response: Response;
  try {
    // Smart round-trip: the router auto-fails-over between PROVIDERS, and our
    // client falls back across MODELS if the picked one is overloaded (429/503)
    // or not enabled for the account (400 model_not_supported).
    response = await routerChatCompletion({
      baseModel: HF_TEXT_MODEL,
      hfToken,
      signal: controller.signal,
      // Ask for schema-valid JSON where the provider supports it; the router
      // enables it only on capable models and degrades to a plain request
      // (same model) otherwise, so `parsePersonaJson` stays the safety net.
      structuredOutput: { name: "reachy_persona", schema: PERSONA_JSON_SCHEMA },
      body: {
        max_tokens: 700,
        temperature: 0.9,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      },
    });
  } catch (err) {
    throw fromRouterError(err);
  } finally {
    window.clearTimeout(timer);
  }

  const payload = (await response.json().catch(() => null)) as
    | ChatCompletionPayload
    | null;
  const raw = extractContent(payload);
  if (!raw) {
    throw new GeneratePersonalityError(
      "bad_response",
      "HF router returned no content",
    );
  }

  const parsed = parsePersonaJson(raw);
  if (!parsed) {
    throw new GeneratePersonalityError(
      "bad_response",
      `could not parse personality JSON from model output: ${raw.slice(0, 200)}`,
    );
  }
  return parsed;
}

const SYSTEM_PROMPT = [
  "You design personalities for Reachy Mini, a small friendly desk robot",
  "that talks out loud via a realtime voice model. You convert a short",
  "user description into a ready-to-use persona.",
  "",
  "Always answer with a SINGLE JSON object and NOTHING else. No prose, no",
  "markdown, no code fences. The object MUST have exactly these keys:",
  '  "name"         string, <= 24 chars, a punchy display name (Title Case).',
  '  "tagline"      string, <= 60 chars, one playful line describing the vibe.',
  '  "instructions" string, the system prompt for the persona (see rules).',
  '  "voice"        string, one of the allowed voice ids listed below.',
  "",
  "Rules for the instructions field:",
  "- Write it as a system prompt addressed to the robot, in English.",
  "- Use these markdown sections in order: '## IDENTITY', then",
  "  '## RESPONSE RULES', then optionally '## QUIRKS'.",
  "- Keep the robot concise: replies of 1-2 sentences, ideally under 25 words.",
  "- The robot speaks English by default and only switches languages if",
  "  explicitly told.",
  "- Stay in character and never mention being an AI or a system prompt.",
  "- Keep the whole instructions field under ~1000 characters.",
  "",
  `Allowed voice ids: ${AVAILABLE_VOICES.join(", ")}.`,
  "Pick the voice that best matches the persona's energy.",
].join("\n");

function buildUserPrompt(vibe: string): string {
  return (
    `Create a Reachy Mini personality from this description:\n"${vibe}"\n\n` +
    "Return only the JSON object."
  );
}

/** Random "ingredient" pools for the surprise-me path. Mixed at call
 *  time into a steering hint so the model explores the space instead of
 *  defaulting to the same few crowd-pleasers. Kept deliberately broad
 *  and a little absurd - the goal is delight, not realism. */
const RANDOM_ARCHETYPES = [
  "a retired stunt double",
  "a conspiracy-minded houseplant enthusiast",
  "an overconfident weather forecaster",
  "a melodramatic theatre director",
  "a deadpan vending machine",
  "a hyper-polite sumo wrestler",
  "a jaded fortune teller",
  "an aristocratic alley cat",
  "a sleep-deprived air traffic controller",
  "a smug crossword champion",
  "a wandering ramen philosopher",
  "a tiny disgraced opera singer",
];

const RANDOM_SETTINGS = [
  "stranded in a 24-hour laundromat",
  "running a pirate radio station",
  "lost in a museum after closing",
  "competing in an underground chess tournament",
  "hosting a late-night call-in show",
  "guarding a lighthouse no one visits",
  "stuck in an elevator with great music",
  "managing a haunted vending route",
];

const RANDOM_QUIRKS = [
  "narrates its own movements",
  "keeps score of everything",
  "speaks in oddly specific metaphors",
  "is convinced it's much taller than it is",
  "treats every question like a riddle",
  "refuses to acknowledge Tuesdays",
  "rates conversations out of ten",
  "whispers as if sharing secrets",
];

function pick<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Compose a single random "vibe" sentence to seed the description box -
 * NOT a full persona. Powers the "Randomize" die next to the vibe input:
 * one tap drops a fresh idea into the field, then the user hits Generate
 * to author the whole persona from it. Local + instant (no model call,
 * no token), drawing from the same ingredient pools as "surprise me" so
 * the suggestions stay varied and a little absurd.
 */
const VIBE_TEMPLATES: ReadonlyArray<
  (archetype: string, setting: string, quirk: string) => string
> = [
  (a, s, q) => `${a} ${s}, who ${q}`,
  (a, s, q) => `${a} who ${q}, ${s}`,
  (a, s, q) => `${a} ${s} and ${q}`,
];

export function generateRandomVibe(): string {
  const template = pick(VIBE_TEMPLATES);
  return template(
    pick(RANDOM_ARCHETYPES),
    pick(RANDOM_SETTINGS),
    pick(RANDOM_QUIRKS),
  ).slice(0, DESCRIPTION_MAX);
}

export interface StreamRandomVibeOptions {
  /** Called with the FULL text-so-far on every streamed chunk, so the UI
   *  can render the sentence as it's typed. */
  onToken: (full: string) => void;
  signal?: AbortSignal;
}

const VIBE_SYSTEM_PROMPT = [
  "You invent playful, original character concepts for Reachy Mini, a",
  "small friendly desk robot that talks out loud.",
  "Reply with ONE short, vivid sentence describing a single persona idea",
  "- and NOTHING else. No quotes, no preamble, no markdown, no list.",
  "Keep it under 140 characters. Make it surprising and specific, never",
  "generic. Write it as a description (e.g. \"a grumpy French chef robot",
  "who thinks it earned a Michelin star\").",
].join("\n");

/**
 * Stream a single random "vibe" sentence from the model into the
 * description box (the "Randomize" die). Unlike {@link generateRandomVibe}
 * (instant + local), this calls the HF router with `stream: true` and
 * surfaces the reply token-by-token via `onToken`, so the field types
 * itself out. Same auth/transport as {@link generatePersonality}; throws
 * `GeneratePersonalityError` so the caller can fall back to the local
 * generator on any failure.
 */
export async function streamRandomVibe(
  opts: StreamRandomVibeOptions,
): Promise<string> {
  const hfToken = readHfTokenFromStorage();
  if (!hfToken) {
    throw new GeneratePersonalityError(
      "hf_token_missing",
      "no HF token in sessionStorage; sign in to Hugging Face first",
    );
  }

  const userPrompt =
    "Invent a fresh persona concept. Loose inspiration (reinterpret " +
    "freely, don't quote literally): " +
    `${pick(RANDOM_ARCHETYPES)}, ${pick(RANDOM_SETTINGS)}, and it ` +
    `${pick(RANDOM_QUIRKS)}. Reply with one sentence only.`;

  let response: Response;
  try {
    response = await routerChatCompletion({
      baseModel: HF_TEXT_MODEL,
      hfToken,
      signal: opts.signal,
      body: {
        max_tokens: 90,
        temperature: 1.0,
        stream: true,
        messages: [
          { role: "system", content: VIBE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      },
    });
  } catch (err) {
    throw fromRouterError(err);
  }

  if (!response.body) {
    throw new GeneratePersonalityError(
      "bad_response",
      "HF router returned an empty stream body",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (possibly partial) line in the buffer.
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            full += delta;
            opts.onToken(cleanVibe(full));
          }
        } catch {
          // Ignore keepalives / partial JSON between chunks.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const result = cleanVibe(full);
  if (!result) {
    throw new GeneratePersonalityError(
      "bad_response",
      "stream produced no content",
    );
  }
  return result;
}

/** Tidy a streamed vibe: strip wrapping quotes the model sometimes adds
 *  and clamp to the description limit. */
function cleanVibe(text: string): string {
  return text
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .slice(0, DESCRIPTION_MAX);
}

function buildRandomPrompt(): string {
  const archetype = pick(RANDOM_ARCHETYPES);
  const setting = pick(RANDOM_SETTINGS);
  const quirk = pick(RANDOM_QUIRKS);
  return (
    "Invent a completely original, surprising Reachy Mini personality " +
    "from scratch. Make it fun and distinctive, not generic.\n" +
    `Loose inspiration (reinterpret freely, don't quote literally): ` +
    `${archetype}, ${setting}, and it ${quirk}.\n\n` +
    "Return only the JSON object."
  );
}

interface ChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  output_text?: string;
}

/** Pull the assistant text out of the OpenAI-compatible envelope,
 *  accepting the same handful of shape variants the VLM provider does
 *  (string content, content-as-array, Responses-API fallback). */
function extractContent(payload: ChatCompletionPayload | null): string {
  if (!payload) return "";
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string" && content) return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part?.text === "string" && part.text) return part.text;
    }
  }
  if (typeof payload.output_text === "string" && payload.output_text) {
    return payload.output_text;
  }
  return "";
}

/**
 * Parse + validate the model's JSON. Defensive against the usual
 * model habits: code fences, leading prose, trailing commentary. We
 * extract the first balanced `{...}` block, JSON-parse it, then clamp
 * every field and snap the voice to a real id. Returns `null` when the
 * payload can't yield the two required fields (name + instructions).
 */
function parsePersonaJson(raw: string): GeneratedPersonality | null {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return null;
  }

  const name = clampString(obj.name, NAME_MAX);
  const instructions = clampString(obj.instructions, INSTRUCTIONS_MAX);
  if (!name || !instructions) return null;

  return {
    name,
    tagline: clampString(obj.tagline, TAGLINE_MAX),
    instructions,
    voice: snapVoice(obj.voice),
  };
}

/** Extract the first balanced top-level JSON object from a string,
 *  ignoring braces that appear inside string literals. Handles models
 *  that wrap the object in ```json fences or surround it with prose. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function clampString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max).trimEnd() : trimmed;
}

/** Map the model's voice guess onto a real `AVAILABLE_VOICES` id.
 *  Case-insensitive exact match; falls back to the first (neutral
 *  default) voice so the picker always has a valid selection. */
function snapVoice(value: unknown): string {
  if (typeof value === "string") {
    const needle = value.trim().toLowerCase();
    const hit = AVAILABLE_VOICES.find((v) => v.toLowerCase() === needle);
    if (hit) return hit;
  }
  return AVAILABLE_VOICES[0];
}
