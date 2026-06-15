/**
 * Engine-side fallback configuration: a default voice + system prompt.
 *
 * These are last-resort constants only. In practice the live session
 * draws its voice + instructions from the ACTIVE PERSONALITY (resolved
 * per-backend via `resolvePersonaVoice`), and the realtime provider is
 * the user's choice in the Conversation settings panel
 * (`ConversationSettingsPanel.tsx`). The shipped default provider is
 * the Hugging Face realtime backend (app-managed session allocator or
 * a direct local websocket, see `shared/env.ts`); OpenAI Realtime is
 * opt-in via that picker. See `conversation-settings/storage.ts`
 * (`DEFAULT_BACKEND`) for the persisted default.
 *
 * `DEFAULT_VOICE` is kept as an HF-shaped fallback for code paths that
 * resolve a voice before a personality is known; it is snapped to the
 * selected backend's catalog downstream.
 */

import { HF_DEFAULT_VOICE } from "./huggingface-realtime";

export const DEFAULT_VOICE = HF_DEFAULT_VOICE;

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
  voice: string;
  instructions: string;
}

export function loadSettings(): Settings {
  return {
    voice: DEFAULT_VOICE,
    instructions: DEFAULT_INSTRUCTIONS,
  };
}
