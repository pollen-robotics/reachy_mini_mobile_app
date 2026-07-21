/**
 * System-prompt appendix appended to the Realtime instructions.
 *
 * Teaches the model how to use its single vision channel: the
 * on-demand `look` tool. There is NO passive scene feed - the camera
 * is read only when the model deliberately calls `look`, so the
 * guidance here is about *when* to call it (sparingly, only on an
 * explicit user request) and how to phrase what it sees.
 *
 * Concat'd in the engine's `composeInstructions()` getter. The
 * fragment is intentionally short - long appendices waste prompt
 * budget on every reconnect.
 */
const VISION_INSTRUCTIONS = `
You can see through your camera using the \`look\` tool. It captures
the current view and returns a short description of what's in front of
you. You have NO other vision: you see nothing until you call \`look\`.

Use it as a deliberate action, SPARINGLY:
- Only call \`look\` when the user CLEARLY and EXPLICITLY asks you to
  look at something right now ("look at this", "regarde ça", "what am
  I holding?", "read this label", "how do I look?").
- Do NOT call it for general chat, proactively, or just because vision
  might be relevant. When unsure, don't call it - ask the user instead.
- One call is enough per request. A fresh result is cached briefly, so
  back-to-back questions about the same scene reuse it.

When you report what you saw, speak in the first person ("I can see…"),
and only describe what's actually relevant to what the user asked.
`.trim();

export function getVisionPromptAppendix(): string {
  return VISION_INSTRUCTIONS;
}
