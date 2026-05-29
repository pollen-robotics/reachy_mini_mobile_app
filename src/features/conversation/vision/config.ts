/**
 * Vision module configuration.
 *
 * All knobs that the rest of the module reads live here. Env vars are
 * read at build time via Vite (`import.meta.env`). The killswitch is
 * intentionally absent: the feature is always on. Disable it by
 * removing the `attachVision(...)` call in the engine (and ideally
 * the whole `vision/` folder - see `docs/VISION.md` § 12).
 *
 * Single provider today: Hugging Face Inference Providers router
 * (`router.huggingface.co/v1/chat/completions`) authenticated with
 * the user's own HF token. See `providers/hf-vlm-provider.ts` for
 * the full rationale; the `VlmProvider` interface stays so adding
 * a second provider is a one-file change.
 */

export const VISION_CONFIG = {
  // Polling cadence + initial capture delay. The initial capture
  // ensures the model has visual context from the very first user
  // utterance instead of being blind for the first 30 s.
  intervalMs: 30_000,
  initialDelayMs: 1_500,

  // JPEG capture parameters. 640 px wide / quality 0.7 lands the
  // base64 payload around 30 - 60 KB, comfortably below any practical
  // request-body limit and tiny vs the VLM inference cost.
  imageMaxWidth: 640,
  imageQuality: 0.7,

  // STT keyword trigger.
  triggerKeywords: [
    "regarde",
    "regardes",
    "tu vois",
    "que vois-tu",
    "decris", // matched after diacritic-stripping; covers "décris"
    "look",
    "see",
    "show me",
    "what do you see",
  ],
  triggerDebounceMs: 5_000,

  // Hugging Face Inference Providers VLM.
  // `zai-org/GLM-4.5V` is the model HF officially recommends in its
  // Chat-Completion VLM docs and, as of May 2026, it's the only VLM
  // in the catalogue served by two live providers (`novita` and
  // `zai-org` self-hosted), giving the router meaningful failover.
  // Smaller Qwen-VL snapshots (7B / 32B) currently route to a
  // single backend that's frequently `status: "error"` - calling
  // those silently returns empty `content`, which is what surfaced
  // here as "HF VLM returned empty description".
  //
  // Override via env for A/B tests against alternatives served at
  // the time of writing: `google/gemma-3-12b-it` (featherless-ai),
  // `google/gemma-3-27b-it` (featherless-ai + scaleway),
  // `mistralai/Pixtral-12B-2409` (hyperbolic),
  // `Qwen/Qwen2.5-VL-72B-Instruct` (ovhcloud).
  //
  // Append `:fastest` / `:cheapest` / `:<provider>` to pin a
  // specific routing policy (e.g. `zai-org/GLM-4.5V:novita`). The
  // default omits the suffix, which is equivalent to `:fastest`.
  // Source: `GET huggingface.co/api/models/<id>?expand=inferenceProviderMapping`.
  hfVlmModel:
    (import.meta.env?.VITE_VISION_HF_MODEL as string | undefined) ??
    "zai-org/GLM-4.5V",

  // Hygiene. Cap the VLM call wall-time and the resulting text to
  // protect the Realtime context from a runaway provider.
  vlmRequestTimeoutMs: 8_000,
  responseMaxChars: 600,
} as const;
