/**
 * System-prompt appendix appended to the Realtime instructions.
 *
 * Teaches the model how to treat the `<scene_observation>` blocks
 * we inject as user messages. Without this, the model would treat
 * every observation as a question and narrate scene changes
 * unprompted ("oh, I see a cup now!"), which is the single biggest
 * UX risk of a passive vision feed.
 *
 * Concat'd in the engine's `composeInstructions()` getter. The
 * fragment is intentionally short - long appendices waste prompt
 * budget on every reconnect.
 */
const SCENE_OBSERVATION_INSTRUCTIONS = `
You may receive periodic <scene_observation> messages with brief
descriptions of what your camera sees. They are PASSIVE background
context, not direct user requests.

- Do NOT narrate them unprompted ("oh, I see a cup now!").
- Only reference what you saw if the user asks ("what do you see?",
  "regarde", "describe the room") OR if it is directly and naturally
  relevant to what they just said.
- Trust the most recent observation; older ones may be stale.
- Observations come from your camera, so refer to them in first
  person ("I can see…"), not third person.
`.trim();

export function getVisionPromptAppendix(): string {
  return SCENE_OBSERVATION_INSTRUCTIONS;
}
