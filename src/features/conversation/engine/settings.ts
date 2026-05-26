/**
 * Engine-side configuration: model defaults + system prompt.
 *
 * The mobile shell has no settings UI, so every value here is
 * baked in as a constant and never persisted.
 *
 * Historic note: this module used to also resolve the OpenAI API
 * key from two sources (a localStorage debug override + a
 * build-time `VITE_OPENAI_API_KEY` injection). Both have been
 * retired: the mobile shell now mints per-user OpenAI Realtime
 * ephemeral keys via the website's `/api/openai/ephemeral`
 * endpoint at conversation-start time. See
 * `./ephemeral-key.ts` for the new acquisition path and
 * `docs/APP_STORE_AUDIT_2026-05.md` § 2.1 for the rationale (the
 * old key was extractable from the bundle and violated OpenAI's
 * ToS for distributed clients).
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
// The server-side mint endpoint also pins this model in its
// default body (server/openaiEphemeral.js); keep both in sync if
// you bump the default here.
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

export interface Settings {
  model: string;
  voice: string;
  instructions: string;
}

export function loadSettings(): Settings {
  return {
    model: DEFAULT_MODEL,
    voice: DEFAULT_VOICE,
    instructions: DEFAULT_INSTRUCTIONS,
  };
}
