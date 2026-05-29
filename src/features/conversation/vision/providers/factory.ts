/**
 * Provider factory.
 *
 * Single-provider today (Hugging Face Inference Providers router).
 * Kept behind a factory so adding a second provider (a local Tauri
 * inference plugin, a Pollen-hosted proxy, ...) is a `case`
 * addition + a new file under `providers/` - no other site in the
 * module needs to change.
 */

import { HfVlmProvider } from "./hf-vlm-provider";
import type { VlmProvider } from "./types";

export interface CreateProviderOptions {
  /** Late-bound HF token accessor. Same source-of-truth as
   *  `engine/ephemeral-key.ts` (the user's HF OAuth token, stored
   *  at `sessionStorage.hf_token`). Called on every VLM call so a
   *  token rotation mid-session is picked up automatically. */
  getHfToken: () => string | null;
}

export function createProvider(opts: CreateProviderOptions): VlmProvider {
  return new HfVlmProvider({ getHfToken: opts.getHfToken });
}
