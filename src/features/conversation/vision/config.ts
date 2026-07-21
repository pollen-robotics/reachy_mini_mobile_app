/**
 * Vision module configuration.
 *
 * All knobs that the rest of the module reads live here. Env-driven
 * knobs come from the typed env funnel (`shared/env.ts`), never from
 * `import.meta.env` directly.
 *
 * The camera is read ONLY on demand, when the model calls the `look`
 * tool - there is no passive/periodic capture. Disable the feature by
 * removing the `attachVision(...)` call in the engine (and ideally
 * the whole `vision/` folder - see `docs/VISION.md` § 12).
 *
 * Single provider today: Hugging Face Inference Providers router
 * (`router.huggingface.co/v1/chat/completions`) authenticated with
 * the user's own HF token. See `providers/hf-vlm-provider.ts` for
 * the full rationale; the `VlmProvider` interface stays so adding
 * a second provider is a one-file change.
 */

import { VISION_HF_MODEL } from '@/shared/env';

export const VISION_CONFIG = {
  // JPEG capture parameters. 640 px wide / quality 0.7 lands the
  // base64 payload around 30 - 60 KB, comfortably below any practical
  // request-body limit and tiny vs the VLM inference cost.
  imageMaxWidth: 640,
  imageQuality: 0.7,

  // Hugging Face Inference Providers VLM.
  // Default `google/gemma-3-27b-it`: a NON-reasoning multimodal model
  // served by two providers (featherless-ai + scaleway), so the router
  // keeps meaningful failover. We deliberately avoid reasoning VLMs
  // here (e.g. `zai-org/GLM-4.5V`): they tend to spend the whole token
  // budget in `reasoning_content` and return an empty `content`, which
  // surfaced as "HF VLM returned empty description".
  //
  // Override via env for A/B tests against alternatives served at
  // the time of writing: `google/gemma-3-12b-it` (featherless-ai),
  // `mistralai/Pixtral-12B-2409` (hyperbolic),
  // `Qwen/Qwen2.5-VL-72B-Instruct` (ovhcloud, single provider),
  // `zai-org/GLM-4.5V` (reasoning - see caveat above).
  //
  // Append `:fastest` / `:cheapest` / `:<provider>` to pin a
  // specific routing policy. The default omits the suffix, which is
  // equivalent to `:fastest`.
  // Source: `GET huggingface.co/api/models/<id>?expand=inferenceProviderMapping`.
  hfVlmModel: VISION_HF_MODEL,

  // Hygiene. Cap the VLM call wall-time and the resulting text to
  // protect the Realtime context from a runaway provider.
  vlmRequestTimeoutMs: 8_000,
  responseMaxChars: 600,

  // On-demand `look` tool freshness window. When the model calls
  // `look` twice in quick succession and the most recent description
  // is younger than this, we return the cached text instead of
  // capturing a new frame + paying the VLM round-trip: the scene
  // almost never changes within a few seconds, so a fresh capture
  // would just add latency for an identical answer. Tuned a touch
  // below a "natural follow-up" window so back-to-back looks
  // ("what's this? … and this?") still re-capture.
  lookCacheFreshnessMs: 6_000,
} as const;
