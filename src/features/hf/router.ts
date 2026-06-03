/**
 * Hugging Face Inference Providers router client - smart model routing.
 *
 * The OpenAI-compatible router (`router.huggingface.co/v1/chat/completions`)
 * already picks an Inference Provider for a model server-side and fails over
 * BETWEEN providers when one is down (with `provider="auto"` / the `:fastest`
 * policy). What it does NOT do is fall back across MODELS, so a request can
 * still fail in two contextual ways we route around here:
 *
 *   1. Overload - every provider for the chosen model is momentarily
 *      saturated (HTTP 429 `server_overload`, 503) or flaky (5xx / network
 *      blip).
 *   2. Unsupported model - the requested model isn't served by any provider
 *      the account has enabled (HTTP 400 `model_not_supported`). Pinning a
 *      provider makes this WORSE, so we don't: we let the router auto-pick and
 *      fall back across a chain of broadly-served MODELS instead.
 *
 * Three router features make this clean rather than guesswork:
 *
 *   - Catalog discovery (`models.ts`, `GET /v1/models`): we prune the chain
 *     to models that actually have a `live` provider before spending a request
 *     on a 400.
 *   - Structured output (`response_format: json_schema`): when the caller asks
 *     for it, we enable it ONLY on models whose live provider advertises
 *     support, and degrade to a plain request (same model) if a provider still
 *     rejects it - the caller's defensive parser is the final safety net.
 *   - Routing policy suffix (`:preferred` by default, also `:fastest` /
 *     `:cheapest`): `:preferred` honours the order the user set in their HF
 *     Inference Provider settings. Override via `VITE_HF_ROUTER_POLICY`.
 *
 * Overloads / 5xx / network blips advance to the next model after a short
 * backoff; an unsupported-model 400 advances instantly. A genuine client
 * error - bad token (401), payment (402), other malformed 400s - fails fast,
 * since no other model would fix it.
 *
 * The model chain is overridable at build time via `VITE_HF_MODEL_CHAIN`
 * (comma-separated model ids); the caller's preferred model is always first.
 *
 * Transport is `@tauri-apps/plugin-http` (`tauriFetch`) so the call isn't
 * subject to browser CORS (the router doesn't serve `*`); the capability is
 * already pinned to `https://router.huggingface.co/*`.
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  fetchModelCatalog,
  modelSupportsStructuredOutput,
  pruneToLive,
  type ModelCatalog,
} from "./models";

export const HF_ROUTER_CHAT_URL =
  "https://router.huggingface.co/v1/chat/completions";

/** Server-side provider-selection policy appended to the model id.
 *  - `auto`      : router default (fastest available), no suffix sent.
 *  - `fastest`   : highest throughput (explicit `:fastest`).
 *  - `cheapest`  : lowest cost per output token.
 *  - `preferred` : the account's own provider order (HF settings). */
export type RouterPolicy = "auto" | "fastest" | "cheapest" | "preferred";

/** Default routing policy. `preferred` respects the user's HF Inference
 *  Provider settings order; override via `VITE_HF_ROUTER_POLICY`. */
const DEFAULT_POLICY: RouterPolicy = (() => {
  const raw = (
    import.meta.env?.VITE_HF_ROUTER_POLICY as string | undefined
  )?.trim();
  if (
    raw === "auto" ||
    raw === "fastest" ||
    raw === "cheapest" ||
    raw === "preferred"
  ) {
    return raw;
  }
  return "preferred";
})();

/**
 * Broadly-served instruct models tried (in order, auto-provider) when the
 * caller's preferred model is overloaded or not enabled for the account.
 * Ordered large -> small so we keep quality when possible but still land
 * on something a minimal account can reach. Override via
 * `VITE_HF_MODEL_CHAIN` (comma-separated model ids).
 */
const DEFAULT_MODEL_CHAIN: string[] = (() => {
  const raw = import.meta.env?.VITE_HF_MODEL_CHAIN as string | undefined;
  if (raw && raw.trim()) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [
    "meta-llama/Llama-3.3-70B-Instruct",
    "Qwen/Qwen2.5-72B-Instruct",
    "meta-llama/Llama-3.1-8B-Instruct",
    "Qwen/Qwen2.5-7B-Instruct",
    "mistralai/Mistral-7B-Instruct-v0.3",
  ];
})();

/** A 429/503 (or a body mentioning overload) is a transient provider
 *  overload, surfaced as a distinct, retry-friendly state. */
export function isOverloadStatus(status: number, body: string): boolean {
  return status === 429 || status === 503 || /overload/i.test(body);
}

/** A 400 whose body flags the model as unserved by the account's enabled
 *  providers - another model in the chain may still work. */
export function isModelUnsupported(status: number, body: string): boolean {
  return (
    status === 400 &&
    /model_not_supported|not supported by any provider/i.test(body)
  );
}

/** A 400 specifically rejecting the structured-output request (the provider
 *  doesn't implement `response_format` / JSON schema). Recoverable by retrying
 *  the SAME model without it. */
function isStructuredOutputRejected(status: number, body: string): boolean {
  return (
    status === 400 &&
    /response_format|json_schema|structured.?output|grammar/i.test(body)
  );
}

/** Whether a failed attempt is worth trying the NEXT model in the chain.
 *  Overloads, 5xx and network blips (`status === 0`) rotate; an
 *  unsupported-model 400 rotates too. Every other client error fails fast
 *  (a different model won't fix a bad token or malformed request). */
function isRetryable(status: number, body: string): boolean {
  return (
    status === 0 ||
    status >= 500 ||
    isOverloadStatus(status, body) ||
    isModelUnsupported(status, body)
  );
}

/** Error thrown when the router request ultimately fails (after exhausting
 *  the model chain). `overloaded` / `modelUnsupported` let callers branch
 *  on the actionable cases without re-parsing status codes. */
export class HfRouterError extends Error {
  readonly status: number;
  readonly body: string;
  readonly overloaded: boolean;
  readonly modelUnsupported: boolean;

  constructor(status: number, body: string) {
    super(
      status === 0
        ? `network error reaching HF router: ${body || "unknown"}`
        : `HF router returned ${status}: ${body.slice(0, 200)}`,
    );
    this.name = "HfRouterError";
    this.status = status;
    this.body = body;
    this.overloaded = isOverloadStatus(status, body);
    this.modelUnsupported = isModelUnsupported(status, body);
  }
}

/** Abortable delay used for the inter-attempt backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/** Build the ordered model chain: the caller's preferred model first, then
 *  the default fallbacks (de-duplicated). */
function buildModelChain(preferred: string): string[] {
  const chain = [preferred, ...DEFAULT_MODEL_CHAIN];
  return chain.filter((m, i) => m && chain.indexOf(m) === i);
}

/** Append the routing policy suffix unless the caller already pinned one
 *  (a `:provider` / `:policy` suffix is left untouched), or the policy is the
 *  server default `auto` (no suffix needed). */
function withPolicy(model: string, policy: RouterPolicy): string {
  if (policy === "auto" || model.includes(":")) return model;
  return `${model}:${policy}`;
}

/** JSON-schema structured-output request (OpenAI `response_format`). */
export interface StructuredOutputSpec {
  /** Schema name (becomes `json_schema.name`). */
  name: string;
  /** The JSON Schema the reply must conform to. */
  schema: Record<string, unknown>;
  /** Enforce strict adherence (`json_schema.strict`). Default `true`. */
  strict?: boolean;
}

export interface RouterChatOptions {
  /** Preferred model id, tried first (e.g. `Qwen/Qwen2.5-72B-Instruct`). */
  baseModel: string;
  /** User HF token (Bearer). */
  hfToken: string;
  /** Request body WITHOUT `model` / `response_format` (we inject both). */
  body: Record<string, unknown>;
  signal?: AbortSignal;
  /** Override the model chain for this call (preferred-first). */
  models?: string[];
  /** Routing policy suffix. Defaults to `VITE_HF_ROUTER_POLICY` or `preferred`. */
  policy?: RouterPolicy;
  /** Ask for JSON-schema structured output where the provider supports it. */
  structuredOutput?: StructuredOutputSpec;
  /** Prune the chain to `live` models via `/v1/models`. Default `true`. */
  discover?: boolean;
  /** Base backoff before retrying after an OVERLOAD; grows per attempt.
   *  Default 600ms. (Unsupported-model fallbacks don't wait.) */
  backoffMs?: number;
  /** Optional hook fired before each attempt (diagnostics / telemetry). */
  onAttempt?: (info: { index: number; model: string; total: number }) => void;
}

/** Single POST to the router for one resolved model, optionally with the
 *  structured-output `response_format` attached. */
function postChat(
  model: string,
  structured: boolean,
  opts: RouterChatOptions,
): Promise<Response> {
  const body: Record<string, unknown> = { ...opts.body, model };
  if (structured && opts.structuredOutput) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: opts.structuredOutput.name,
        strict: opts.structuredOutput.strict ?? true,
        schema: opts.structuredOutput.schema,
      },
    };
  }
  return tauriFetch(HF_ROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.hfToken}`,
    },
    signal: opts.signal,
    body: JSON.stringify(body),
  });
}

/**
 * POST a chat-completions request, falling back across the model chain when
 * the active model is overloaded or unsupported for the account. Prunes the
 * chain to live models first (best-effort discovery), requests structured
 * output where supported (degrading per-model if a provider rejects it), and
 * applies the routing policy suffix. Returns the first OK `Response` (caller
 * owns reading the body / stream). Throws `HfRouterError` once the chain is
 * exhausted - with `overloaded` / `modelUnsupported` set from the LAST failure
 * so the UI can give an actionable message - or rethrows `AbortError`.
 */
export async function routerChatCompletion(
  opts: RouterChatOptions,
): Promise<Response> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const backoff = opts.backoffMs ?? 600;
  const wantStructured = Boolean(opts.structuredOutput);

  // Best-effort catalog: an empty map (discovery off/failed) makes both
  // pruning a no-op and structured-output optimistic, so behaviour degrades
  // cleanly to "try the whole chain".
  const catalog: ModelCatalog =
    opts.discover === false
      ? (new Map() as ModelCatalog)
      : await fetchModelCatalog(opts.hfToken, opts.signal).catch(
          () => new Map() as ModelCatalog,
        );

  const models = pruneToLive(
    opts.models ?? buildModelChain(opts.baseModel),
    catalog,
  );
  let lastError: HfRouterError | null = null;

  for (let i = 0; i < models.length; i++) {
    const requestModel = withPolicy(models[i], policy);
    opts.onAttempt?.({ index: i, model: requestModel, total: models.length });

    const useStructured =
      wantStructured && modelSupportsStructuredOutput(models[i], catalog);

    let response: Response;
    try {
      response = await postChat(requestModel, useStructured, opts);
    } catch (err) {
      // A real abort propagates immediately; otherwise treat as a network
      // blip worth trying the next model for.
      if (opts.signal?.aborted) throw err;
      lastError = new HfRouterError(0, (err as Error)?.message ?? "unknown");
      if (i < models.length - 1) await sleep(backoff * (i + 1), opts.signal);
      continue;
    }

    if (response.ok) return response;

    // Read the error body once to classify (a fresh Response per attempt
    // means consuming it here is fine).
    let text = await response.text().catch(() => "");

    // Provider rejected structured output -> retry the SAME model in plain
    // mode before rotating (the defensive parser recovers the JSON anyway).
    if (useStructured && isStructuredOutputRejected(response.status, text)) {
      try {
        const plain = await postChat(requestModel, false, opts);
        if (plain.ok) return plain;
        response = plain;
        text = await plain.text().catch(() => "");
      } catch (err) {
        if (opts.signal?.aborted) throw err;
      }
    }

    const error = new HfRouterError(response.status, text);
    lastError = error;

    // Fail fast on genuine client errors; only fall back on retryable ones.
    if (!isRetryable(response.status, text)) throw error;
    if (i < models.length - 1) {
      // Back off only for overloads / 5xx; an unsupported model is instant.
      if (error.overloaded || response.status >= 500) {
        await sleep(backoff * (i + 1), opts.signal);
      }
    }
  }

  throw lastError ?? new HfRouterError(0, "no models attempted");
}
