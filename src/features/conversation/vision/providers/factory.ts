/**
 * Provider factory.
 *
 * Single-provider today (OpenAI). Kept behind a factory so adding a
 * second provider (HF SmolVLM, a local Tauri inference plugin, …) is
 * a `case` addition + a new file under `providers/` - no other site
 * in the module needs to change.
 */

import { OpenaiVlmProvider } from "./openai-vlm-provider";
import type { VlmProvider } from "./types";

export interface CreateProviderOptions {
  /** Reused for the OpenAI Vision call. Same key the engine uses
   *  for the Realtime API. */
  openaiApiKey: string;
}

export function createProvider(opts: CreateProviderOptions): VlmProvider {
  return new OpenaiVlmProvider({ apiKey: opts.openaiApiKey });
}
