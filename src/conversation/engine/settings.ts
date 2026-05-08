/**
 * Engine-side configuration: model defaults + system prompt +
 * localStorage hydration.
 *
 * Read-only at runtime: the mobile shell configures HF token /
 * OpenAI key through its own settings screens (or `.env.local` at
 * build time for the OpenAI key), so the engine no longer owns a
 * "settings modal" on top of the orb. Keeping the loader pure
 * means there's no surprise persistence happening inside the
 * conversation pipeline.
 */

export const DEFAULT_MODEL = 'gpt-realtime';
export const DEFAULT_VOICE = 'cedar';

export const DEFAULT_INSTRUCTIONS =
  'You are Reachy Mini, a small friendly robot companion. ' +
  'Keep replies short, warm, and spoken. Avoid long monologues. ' +
  'You control a small robot body and can manage a small long-term ' +
  'memory. Tools available:\n' +
  '  - `move_head`: point the head in a named direction (up, down, left, ' +
  'right, tilt_left, tilt_right, center). Instant, use for subtle gestures ' +
  'that accompany a sentence.\n' +
  '  - `play_move`: trigger a short pre-recorded choreography (1-4s). The ' +
  'catalog mixes `dance` entries (rhythmic, playful) and `emotion` entries ' +
  '(reactive body language). Pick a dance when the moment calls for ' +
  'theatricality (hi, joke, groove) and an emotion when reacting to ' +
  'something the user just said (surprise, curiosity, praise, bad news).\n' +
  '  - `remember`: save ONE short fact about the user that will help in ' +
  'future conversations (their name, preferences, recurring projects, ' +
  'people they care about, plans). Only save things that are stable and ' +
  'the user explicitly shared. Never save sensitive data (passwords, ' +
  'addresses, payment info). Each call stores ONE atomic fact - split ' +
  'compound statements into multiple calls.\n' +
  '  - `forget`: remove a previously saved fact when the user asks you ' +
  'to or when the information becomes obsolete.\n' +
  'Use motion tools sparingly (never more than once per reply). Use ' +
  'memory tools silently in the background - do not narrate the act of ' +
  "remembering, just acknowledge naturally (\"got it\", \"noted\").";

export const STORAGE_KEYS = {
  hfClientId: 'reachyMini.hf.clientId',
  apiKey: 'reachyMini.openai.apiKey',
  model: 'reachyMini.openai.model',
  voice: 'reachyMini.openai.voice',
  instructions: 'reachyMini.openai.instructions',
} as const;

export interface Settings {
  hfClientId: string;
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
}

/**
 * ⚠️ TEMPORARY: build-time OpenAI key, populated by Vite from
 * `.env.local` at build time (`VITE_OPENAI_API_KEY=…`). The
 * mobile shell currently has no settings screen for the key, so
 * we let developers bake theirs into the bundle - and the GitHub
 * Actions workflow does the same for TestFlight / internal
 * Android builds via the `OPENAI_API_KEY` repo secret (see
 * `.github/workflows/build-mobile.yml`). `.env.local` is in
 * `.gitignore`, so the secret never reaches the repo, but it
 * DOES end up in the distributed `.ipa` / `.apk` - anyone with
 * the binary can extract the key.
 *
 * This is a known anti-pattern, kept ONLY for the debug /
 * internal-tester window where we want the conversation to
 * "just work" out of the box. Production releases MUST replace
 * this with a proper architecture (server-side ephemeral keys,
 * per-user OAuth, …) and remove the build-time injection from
 * both `.env.local` AND the workflow's three "Inject OpenAI
 * API key (TEMPORARY)" steps.
 */
const BUILD_TIME_OPENAI_KEY: string =
  (import.meta.env?.VITE_OPENAI_API_KEY as string | undefined) ?? '';

export function loadSettings(): Settings {
  return {
    hfClientId: localStorage.getItem(STORAGE_KEYS.hfClientId) ?? '',
    apiKey: localStorage.getItem(STORAGE_KEYS.apiKey) ?? BUILD_TIME_OPENAI_KEY,
    model: localStorage.getItem(STORAGE_KEYS.model) ?? DEFAULT_MODEL,
    voice: localStorage.getItem(STORAGE_KEYS.voice) ?? DEFAULT_VOICE,
    instructions:
      localStorage.getItem(STORAGE_KEYS.instructions) ?? DEFAULT_INSTRUCTIONS,
  };
}
