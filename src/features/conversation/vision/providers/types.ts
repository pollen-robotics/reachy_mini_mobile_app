/**
 * VLM provider abstraction.
 *
 * Keeping this interface even with a single concrete provider today
 * is cheap (~10 lines) and pays for itself the moment we add a
 * second provider (HF SmolVLM, a local Tauri inference plugin, …):
 * none of the scene poller / injector / capture logic has to change.
 */

import type { CapturedFrame, DescribeOptions } from "../types";

export interface VlmProvider {
  /** Stable display name. Used in logs to disambiguate which
   *  provider produced which description. */
  readonly name: string;
  /** Describe what's in the frame. Implementations must respect
   *  `opts.abortSignal` and a sane internal timeout. Returns a
   *  short (1 - 2 sentence) factual description, free of "I can
   *  see…" prefixes (the system prompt teaches the model to
   *  speak in first person about observations; the provider
   *  itself stays neutral). */
  describeScene(frame: CapturedFrame, opts: DescribeOptions): Promise<string>;
}
