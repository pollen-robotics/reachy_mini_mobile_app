/**
 * Vision module configuration.
 *
 * All knobs that the rest of the module reads live here. Env vars are
 * read at build time via Vite (`import.meta.env`). The killswitch is
 * intentionally absent: the feature is always on. Disable it by
 * removing the `attachVision(...)` call in the engine (and ideally
 * the whole `vision/` folder - see `docs/VISION.md` § 12).
 *
 * Single provider for now (OpenAI gpt-4o-mini). The HF SmolVLM
 * scaffold mentioned in the design doc is deliberately not present;
 * the `VlmProvider` interface stays so adding a second provider is a
 * one-file change.
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

  // OpenAI Vision provider.
  // The model is overridable via env for cheap A/B tests against
  // newer snapshots without rebuilding the bundle's logic.
  openaiVlmModel:
    (import.meta.env?.VITE_VISION_OPENAI_MODEL as string | undefined) ??
    "gpt-4o-mini",
  // `low` detail keeps the per-call cost negligible. Bump to
  // `high` only if a downstream user complaints about coarse scene
  // descriptions; the latency cost is real.
  openaiVlmDetail: "low" as const,

  // Hygiene. Cap the VLM call wall-time and the resulting text to
  // protect the Realtime context from a runaway provider.
  vlmRequestTimeoutMs: 8_000,
  responseMaxChars: 600,
} as const;
