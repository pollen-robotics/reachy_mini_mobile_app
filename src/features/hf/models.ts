/**
 * HF Inference Providers model catalog (`router.huggingface.co/v1/models`).
 *
 * The router exposes a public, OpenAI-style listing of every model it can
 * serve, and crucially WHICH providers back each one and what they support:
 *
 *   {
 *     "data": [{
 *       "id": "deepseek-ai/DeepSeek-V4-Pro",
 *       "providers": [
 *         { "provider": "novita", "status": "live",
 *           "supports_structured_output": false, ... },
 *         { "provider": "together", "status": "live",
 *           "supports_structured_output": true,  ... }
 *       ]
 *     }, ...]
 *   }
 *
 * We distill that into a tiny per-model summary the router uses to:
 *   1. prune its fallback chain to models that actually have a `live`
 *      provider (skip decommissioned / mistyped ids before paying a 400);
 *   2. decide whether to ask for JSON-schema structured output (only where a
 *      live provider advertises it - otherwise we'd just 400 and degrade).
 *
 * Best-effort by design: every failure path resolves to an EMPTY catalog so
 * callers transparently fall back to "try the whole chain, guess optimistic".
 * The result is cached briefly (the catalog barely moves) and in-flight
 * requests are de-duplicated.
 *
 * Transport is `@tauri-apps/plugin-http` (`tauriFetch`) for the same CORS
 * reason as the chat endpoint; the capability is already pinned to
 * `https://router.huggingface.co/*`.
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export const HF_ROUTER_MODELS_URL = "https://router.huggingface.co/v1/models";

/** Per-model summary distilled from the router's provider list. */
export interface ModelInfo {
  /** At least one provider serving this model is currently `live`. */
  live: boolean;
  /** At least one live provider advertises JSON-schema structured output. */
  structuredOutput: boolean;
}

export type ModelCatalog = ReadonlyMap<string, ModelInfo>;

/** The catalog changes rarely; a short TTL keeps the extra GET off the hot
 *  path without serving a stale list for long. */
const CATALOG_TTL_MS = 10 * 60_000;

let cache: { at: number; catalog: ModelCatalog } | null = null;
let inflight: Promise<ModelCatalog> | null = null;

interface RawModelsResponse {
  data?: Array<{
    id?: string;
    providers?: Array<{
      status?: string;
      supports_structured_output?: boolean;
    }>;
  }>;
}

function parseCatalog(json: RawModelsResponse): ModelCatalog {
  const map = new Map<string, ModelInfo>();
  for (const model of json.data ?? []) {
    if (!model?.id) continue;
    const live = (model.providers ?? []).filter((p) => p?.status === "live");
    map.set(model.id, {
      live: live.length > 0,
      structuredOutput: live.some((p) => p?.supports_structured_output === true),
    });
  }
  return map;
}

/**
 * Fetch (and briefly cache) the router model catalog. The endpoint is public,
 * but the token is forwarded when present so the router can scope the listing
 * to the account's enabled providers. Resolves to an EMPTY catalog on any
 * failure (HTTP error, bad body, network blip, abort) so the caller degrades
 * gracefully instead of throwing.
 */
export async function fetchModelCatalog(
  hfToken?: string,
  signal?: AbortSignal,
): Promise<ModelCatalog> {
  const now = Date.now();
  if (cache && now - cache.at < CATALOG_TTL_MS) return cache.catalog;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await tauriFetch(HF_ROUTER_MODELS_URL, {
        method: "GET",
        headers: hfToken ? { Authorization: `Bearer ${hfToken}` } : {},
        signal,
      });
      if (!res.ok) return new Map() as ModelCatalog;
      const json = (await res.json().catch(() => null)) as
        | RawModelsResponse
        | null;
      if (!json) return new Map() as ModelCatalog;
      const catalog = parseCatalog(json);
      // Only cache a non-empty catalog; an empty one is likely a transient
      // hiccup we'd rather retry than serve for the full TTL.
      if (catalog.size > 0) cache = { at: Date.now(), catalog };
      return catalog;
    } catch {
      return new Map() as ModelCatalog;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Strip any `:policy` / `:provider` routing suffix to get the bare model id
 *  used as the catalog key (e.g. `Qwen/Qwen2.5-72B-Instruct:groq` -> base). */
export function bareModelId(model: string): string {
  const i = model.indexOf(":");
  return i === -1 ? model : model.slice(0, i);
}

/** Keep only models the catalog marks `live`, preserving order. When the
 *  catalog is empty (discovery failed) - or pruning would empty the chain -
 *  the input is returned unchanged so we still try every candidate. */
export function pruneToLive(models: string[], catalog: ModelCatalog): string[] {
  if (catalog.size === 0) return models;
  const live = models.filter((m) => catalog.get(bareModelId(m))?.live);
  return live.length > 0 ? live : models;
}

/** Whether a model has a live provider advertising JSON-schema structured
 *  output. Unknown (catalog miss / empty) -> `true`: we attempt it optimistically
 *  and rely on the router's request-time degradation if the guess is wrong. */
export function modelSupportsStructuredOutput(
  model: string,
  catalog: ModelCatalog,
): boolean {
  if (catalog.size === 0) return true;
  const info = catalog.get(bareModelId(model));
  return info ? info.structuredOutput : true;
}
