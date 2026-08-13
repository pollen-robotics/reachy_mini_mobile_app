/**
 * Public surface of the HF Inference Providers client.
 *
 * A generic, transport-level wrapper around OpenAI-compatible chat
 * completions (plus the router's model catalog). Lives outside any single
 * feature so every caller (personality authoring, sticker theming, vision,
 * ...) routes through the same backend selection / fallback / discovery /
 * structured-output logic.
 */
export {
  HF_ROUTER_CHAT_URL,
  HfRouterError,
  SPACE_CHAT_URL,
  isModelUnsupported,
  isOverloadStatus,
  routerChatCompletion,
} from "./router";
export type { RouterChatOptions, RouterPolicy, StructuredOutputSpec } from "./router";
export {
  HF_ROUTER_MODELS_URL,
  bareModelId,
  fetchModelCatalog,
  modelSupportsStructuredOutput,
  pruneToLive,
} from "./models";
export type { ModelCatalog, ModelInfo } from "./models";
