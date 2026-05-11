/**
 * Engine-side configuration: model defaults + system prompt +
 * OpenAI key resolution.
 *
 * The mobile shell has no settings UI, so most values are baked
 * in here as constants and never persisted. Only the OpenAI API
 * key has two sources:
 *
 *   1. `localStorage` override (manual debug escape hatch -
 *      `localStorage.setItem('reachyMini.openai.apiKey', '…')`
 *      from DevTools)
 *   2. Build-time fallback from `VITE_OPENAI_API_KEY` in
 *      `.env.local` (the normal path - see `.env.example` and
 *      the GitHub Actions workflow)
 *
 * If neither is set, the engine surfaces "Add OpenAI key in
 * settings" when the user taps the orb to start a conversation.
 *
 * Historic note: an earlier version of this file mirrored the
 * Space app's full settings infrastructure (HF clientId stored
 * in localStorage, model/voice/instructions configurable from a
 * UI modal). The mobile shell has none of that, so the
 * scaffolding has been collapsed down to the one value that
 * actually has two viable sources.
 */

// `gpt-realtime-2` is OpenAI's reasoning-capable Realtime model
// (released late 2025 / early 2026). vs the earlier `gpt-realtime`
// snapshot it brings stronger instruction following, more reliable
// tool use, a 128k context window, and higher tolerance for long /
// nested system prompts - at the cost of higher latency (the model
// can briefly "think" before speaking) and ~4x audio token pricing
// (~$32 / $64 per M in/out vs ~$8 / $24 for `gpt-realtime`).
//
// The latency cost is mitigated by pinning `reasoning.effort: "low"`
// in `buildSessionConfig()` (`openai-realtime.ts`), which is OpenAI's
// recommended setting for production voice agents - any higher and
// the time-to-first-audio becomes perceptible mid-conversation.
//
// IMPORTANT: this model is **GA-only**, i.e. it requires the new
// `POST /v1/realtime/calls` handshake (FormData body with
// `sdp` + `session`). The legacy Beta endpoint
// (`POST /v1/realtime?model=...`, raw SDP) returns
// `400 invalid_model "Model gpt-realtime-2 is only available on the
// GA API."`. The handshake migration is done in `openai-realtime.ts`.
//
// Rollback path (if the GA handshake misbehaves on a specific
// device or network): set this back to `'gpt-realtime'`. The GA
// handshake also accepts that snapshot.
export const DEFAULT_MODEL = 'gpt-realtime-2';
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

/**
 * The single localStorage key still in use: a manual debug
 * override for the OpenAI API key. The mobile UI never writes
 * to it - developers can set it from DevTools when they want
 * to override the build-time key without rebuilding.
 */
const API_KEY_STORAGE_KEY = 'reachyMini.openai.apiKey';

export interface Settings {
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
  // `||` (not `??`) so an empty-string entry in localStorage still
  // falls through to the build-time fallback. The legacy engine
  // could persist `""` when the user submitted an empty settings
  // form; once that landed in storage, `??` (which only fallbacks
  // on null/undefined) trapped the engine on the empty value
  // forever, even after we shipped a build-time key.
  const fromStorage = localStorage.getItem(API_KEY_STORAGE_KEY);
  const apiKey = fromStorage || BUILD_TIME_OPENAI_KEY;
  // Diagnostic log (length only - never the key value): confirms
  // which source resolved the OpenAI key. Helps debug "the engine
  // says no key" when the .env.local is set OR when localStorage
  // has a stale empty/wrong value.
  console.info(
    '[settings] OpenAI key sources:',
    'localStorage =',
    fromStorage === null
      ? 'unset'
      : fromStorage === ''
        ? 'empty string (will fall back)'
        : `set (${fromStorage.length} chars)`,
    '| build-time =',
    BUILD_TIME_OPENAI_KEY === ''
      ? 'unset (no .env.local or VITE_OPENAI_API_KEY missing)'
      : `set (${BUILD_TIME_OPENAI_KEY.length} chars)`,
    '| resolved =',
    apiKey ? `${apiKey.length} chars` : 'EMPTY (engine will prompt)',
  );
  return {
    apiKey,
    model: DEFAULT_MODEL,
    voice: DEFAULT_VOICE,
    instructions: DEFAULT_INSTRUCTIONS,
  };
}
