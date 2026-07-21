/**
 * Scene description → Realtime context injector.
 *
 * Mirrors a `look` result back into the conversation as a
 * `conversation.item.create` event, wrapping the description in a
 * `<scene_observation>` block, so later turns can reference "what you
 * saw" even after the tool output ages out of context. No
 * `response.create` follow-up: this is context, NOT a prompt to speak
 * (the model already spoke from the tool result on the original look).
 *
 * Role is `"user"` because the Realtime API doesn't accept arbitrary
 * `system` items mid-conversation. The `<scene_observation>` tag marks
 * it as a camera memory rather than a fresh user utterance.
 */

import type { RealtimePort } from "../engine/realtime/types";
import type { SceneTrigger } from "./types";

export interface SceneInjector {
  inject: (description: string, trigger: SceneTrigger) => void;
}

export interface CreateSceneInjectorOptions {
  realtime: RealtimePort;
}

export function createSceneInjector(
  opts: CreateSceneInjectorOptions,
): SceneInjector {
  const inject = (description: string, trigger: SceneTrigger): void => {
    const trimmed = description.trim();
    if (!trimmed) {
      console.debug("[vision] inject: empty description, skipping");
      return;
    }

    const timestamp = formatLocalTime(new Date());
    const safeDescription = sanitiseForXml(trimmed);

    const text =
      `<scene_observation source="camera" trigger="${trigger}" timestamp="${timestamp}">\n` +
      `${safeDescription}\n` +
      `</scene_observation>`;

    opts.realtime.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });

    console.info(
      `[vision] injected scene_observation (${trigger}, ${timestamp}): ` +
        `${trimmed.slice(0, 80)}${trimmed.length > 80 ? "…" : ""}`,
    );
  };

  return { inject };
}

/** Local wall-clock `HH:MM:SS`. The model uses it to differentiate
 *  "what you saw 5 minutes ago" from "what you see now". */
function formatLocalTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Prevent the VLM's free-form text from breaking out of the
 * `<scene_observation>` wrapper. We don't run a full XML-escape (the
 * Realtime model isn't an XML parser - the tag is a convention, not
 * structured data), just neutralise the obvious risks:
 *   - close-tag literal embedded in the description
 *   - newlines that would let the model read past the block boundary
 *     visually
 */
function sanitiseForXml(s: string): string {
  return s
    .replace(/<\/scene_observation>/gi, "</scene_observation _>")
    .replace(/\r?\n+/g, " ");
}
