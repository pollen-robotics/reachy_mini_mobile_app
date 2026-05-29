/**
 * Scene description → Realtime context injector.
 *
 * Builds a `conversation.item.create` event with the description
 * wrapped in a `<scene_observation>` block and ships it over the
 * `RealtimePort`. No `response.create` follow-up: we are adding
 * background context, NOT asking the model to speak. The model only
 * reacts when the user actually says something.
 *
 * Role is `"user"` because the Realtime API doesn't accept arbitrary
 * `system` items mid-conversation. The `<scene_observation>` tag +
 * the system-prompt appendix in `prompt-fragment.ts` are what teach
 * the model to treat the message as passive context instead of a
 * direct user utterance.
 */

import type { RealtimePort } from "../engine/bridge/huggingface-bridge";
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
