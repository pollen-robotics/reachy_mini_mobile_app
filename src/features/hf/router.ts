/**
 * Chat-completions client - two transports, one OpenAI-compatible dialect.
 *
 * 1. The sticker Space's text proxy (`POST /api/chat/completions`), used by
 *    default (`TEXT_GEN_BACKEND === 'space'`). The Space spends its OWN
 *    provider credentials, which is the whole point: a user who never
 *    enabled an Inference Provider on their account gets
 *    `model_not_supported` from the direct router, so persona authoring
 *    would be dead on arrival for them. Model choice + fallback live
 *    server-side there (on fal today, hence a model vocabulary that has
 *    nothing to do with our HF ids).
 * 2. The HF Inference Providers router, called straight from the device with
 *    the USER's token. The historical path, kept as a build-time escape
 *    hatch AND as an automatic fallback when the Space is unreachable
 *    (Spaces sleep after inactivity, restart on deploy, and 404 until the
 *    route ships). Everything below documents this path.
 *
 * Both speak the same request/response shape, so callers hand us the same
 * options either way and read the same `Response`.
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
  HF_MODEL_CHAIN,
  HF_ROUTER_POLICY,
  STICKER_API_URL,
  TEXT_GEN_BACKEND,
} from "@/shared/env";
import { notifyHfTokenInvalid } from "@/features/auth/tokenInvalidation";
import {
  fetchModelCatalog,
  modelSupportsStructuredOutput,
  pruneToLive,
  type ModelCatalog,
} from "./models";

export const HF_ROUTER_CHAT_URL =
  "https://router.huggingface.co/v1/chat/completions";

/** The sticker Space's OpenAI-compatible text proxy. Same request/response
 *  dialect as the HF router (that's the point), but billed to the Space so
 *  the feature works for users with no Inference Provider enabled. */
export const SPACE_CHAT_URL = `${STICKER_API_URL.replace(/\/$/, "")}/api/chat/completions`;

/** Server-side provider-selection policy appended to the model id.
 *  - `auto`      : router default (fastest available), no suffix sent.
 *  - `fastest`   : highest throughput (explicit `:fastest`).
 *  - `cheapest`  : lowest cost per output token.
 *  - `preferred` : the account's own provider order (HF settings). */
export type RouterPolicy = "auto" | "fastest" | "cheapest" | "preferred";

/** Default routing policy. `preferred` respects the user's HF Inference
 *  Provider settings order; override via `VITE_HF_ROUTER_POLICY`. Read
 *  + validated in the env funnel (`shared/env.ts`). */
const DEFAULT_POLICY: RouterPolicy = HF_ROUTER_POLICY;

/**
 * Broadly-served instruct models tried (in order, auto-provider) when the
 * caller's preferred model is overloaded or not enabled for the account.
 * Ordered large -> small so we keep quality when possible but still land
 * on something a minimal account can reach. Sourced (and overridable via
 * `VITE_HF_MODEL_CHAIN`) from the env funnel (`shared/env.ts`).
 */
const DEFAULT_MODEL_CHAIN: string[] = HF_MODEL_CHAIN;

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
  /** Hard credentials rejection (HTTP 401): the bearer is bad/expired or
   *  its signature no longer verifies. Not fixable by another model - the
   *  app shell reacts by evicting the token and re-prompting sign-in. */
  readonly authInvalid: boolean;

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
    this.authInvalid = status === 401;
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

/** Chat-completions body, optionally carrying the structured-output
 *  `response_format`. Shared by both transports - the Space proxy speaks the
 *  same dialect as the router. A null `model` omits the field entirely,
 *  which is how we let the proxy pick from its own catalog. */
function buildChatBody(
  model: string | null,
  structured: boolean,
  opts: RouterChatOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...opts.body };
  if (model !== null) body.model = model;
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
  return body;
}

/** Single POST to the router for one resolved model, optionally with the
 *  structured-output `response_format` attached. */
function postChat(
  model: string,
  structured: boolean,
  opts: RouterChatOptions,
): Promise<Response> {
  return tauriFetch(HF_ROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.hfToken}`,
    },
    signal: opts.signal,
    body: JSON.stringify(buildChatBody(model, structured, opts)),
  });
}

/** A Space response that means "the proxy isn't there right now" rather
 *  than "your request was wrong": Spaces sleep after inactivity, restart on
 *  deploy, and don't answer the route at all until it ships. Each of those
 *  is worth degrading to the user's own token for; a 400/401/429 is not.
 *
 *  405 counts, and is in fact what an older Space actually replies: the
 *  backend mounts its React build with `StaticFiles` at `/`, which claims
 *  every unmatched path and rejects a POST with "Method Not Allowed"
 *  instead of a 404. Reading that as a client error would strand the app on
 *  a hard failure for the entire rollout window. */
function isSpaceUnavailable(status: number): boolean {
  return status === 404 || status === 405 || status >= 500;
}

/**
 * Try the Space's text proxy for this request.
 *
 * Returns the OK `Response` on success, or `null` when the Space itself is
 * unavailable - the caller then degrades to the direct router with the
 * user's own token, which is exactly today's behaviour. Definitive
 * failures (malformed request, rejected token, rate limit) throw
 * `HfRouterError` instead, so they surface with the same vocabulary as the
 * direct path rather than silently costing the user a second round-trip.
 *
 * No model, no chain and no catalog discovery here: the Space owns all
 * three. It knows which models ITS credentials can reach, which is not
 * something the user's `/v1/models` view can answer - and the two don't
 * even share a vocabulary (the proxy runs on fal/OpenRouter ids, our
 * `baseModel` defaults are HF ids). Sending ours would just earn a 400, so
 * `baseModel` stays what it has always been: the preference for the direct
 * router fallback below.
 */
async function trySpaceChatCompletion(
  opts: RouterChatOptions,
): Promise<Response | null> {
  const body = buildChatBody(null, Boolean(opts.structuredOutput), opts);

  let response: Response;
  try {
    response = await tauriFetch(SPACE_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // For HF's access proxy in front of a private Space, not for
        // inference: the backend spends its own credentials. Harmless
        // while the Space is public.
        ...(opts.hfToken ? { Authorization: `Bearer ${opts.hfToken}` } : {}),
      },
      signal: opts.signal,
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    console.warn("[hf] text proxy unreachable, falling back to router:", err);
    return null;
  }

  if (response.ok) return response;

  const text = await response.text().catch(() => "");
  if (isSpaceUnavailable(response.status)) {
    console.warn(
      `[hf] text proxy returned ${response.status}, falling back to router`,
    );
    return null;
  }

  const error = new HfRouterError(response.status, text);
  // A 401 here is HF's access proxy rejecting the USER's token (the Space's
  // own credential problems come back as 503), so the eviction is right.
  if (error.authInvalid) notifyHfTokenInvalid();
  throw error;
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
  // Preferred transport: the Space proxy (see `TEXT_GEN_BACKEND`). It only
  // returns null when the Space is unavailable, in which case we carry on to
  // the direct router below with the user's own token.
  if (TEXT_GEN_BACKEND === "space") {
    const viaSpace = await trySpaceChatCompletion(opts);
    if (viaSpace) return viaSpace;
  }

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
    if (!isRetryable(response.status, text)) {
      // A hard 401 means HF rejected the bearer itself (bad/expired token or
      // a signature that no longer verifies). No other model would fix it, so
      // signal the app shell to evict the token and re-prompt sign-in.
      if (error.authInvalid) notifyHfTokenInvalid();
      throw error;
    }
    if (i < models.length - 1) {
      // Back off only for overloads / 5xx; an unsupported model is instant.
      if (error.overloaded || response.status >= 500) {
        await sleep(backoff * (i + 1), opts.signal);
      }
    }
  }

  throw lastError ?? new HfRouterError(0, "no models attempted");
}
