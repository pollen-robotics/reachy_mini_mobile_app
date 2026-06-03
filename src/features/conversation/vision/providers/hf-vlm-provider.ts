/**
 * Hugging Face Inference Providers VLM provider.
 *
 * Hits HF's OpenAI-compatible Chat Completions router
 * (`router.huggingface.co/v1/chat/completions`) with the user's own
 * HF access token. The router auto-selects a backend provider
 * (Hyperbolic, Together, Fireworks, Replicate, ...) based on a
 * routing policy and forwards the request, returning an
 * OpenAI-Chat-Completions-shaped payload.
 *
 * Why this provider
 * ------------------------------------------------
 * 1. **No master key on the wire.** The HF router accepts the user's
 *    own HF token, which is already in `sessionStorage` for the
 *    realtime session allocator.
 *
 * 2. **Per-user billing.** Calls land on the user's HF account
 *    (their $0.10/mo free tier, their $2/mo PRO credits, their
 *    pay-as-you-go cap), not on Pollen's shared provider bill. A runaway
 *    user can't drain a shared budget.
 *
 * 3. **Backend swap = config change.** Switching from
 *    `Qwen/Qwen2.5-VL-7B-Instruct` to `meta-llama/Llama-3.2-90B-
 *    Vision-Instruct` or any other VLM in the HF catalogue is a
 *    one-line config change. The provider router handles routing.
 *
 * Decoupling from gpt-realtime
 * ----------------------------
 * Vision runs through a SEPARATE HTTP round-trip to HF's router,
 * fully independent of the HF realtime voice bridge. Replacing
 * the conversation backend later requires zero changes here.
 * Likewise, swapping `Qwen2.5-VL` for a future
 * HF model (or pinning a specific provider via `:fastest` /
 * `:cheapest` suffix on the model id) requires zero changes in the
 * conversation engine.
 *
 * Endpoint reference
 * ------------------
 *   POST https://router.huggingface.co/v1/chat/completions
 *   Authorization: Bearer <hf_token>
 *   Content-Type: application/json
 *   Body: {
 *     model: "Qwen/Qwen2.5-VL-7B-Instruct",
 *     messages: [{
 *       role: "user",
 *       content: [
 *         { type: "text",      text: <prompt> },
 *         { type: "image_url", image_url: { url: "data:image/...;base64,..." } }
 *       ]
 *     }],
 *     max_tokens: 200
 *   }
 *
 *   200 -> { choices: [{ message: { content: "..." } }], ... }
 *
 * See: https://huggingface.co/docs/inference-providers/en/index
 */

import { routerChatCompletion } from "@/features/hf";

import { VISION_CONFIG } from "../config";
import type { CapturedFrame, DescribeOptions } from "../types";
import type { VlmProvider } from "./types";

/**
 * We use the OpenAI-compatible Chat Completions endpoint rather than the
 * newer Responses API. Both work through the HF router, but Chat Completions
 * is the GA "drop-in OpenAI replacement" (per HF's docs) and Vision via
 * `image_url` content parts is the canonical OpenAI shape every VLM in the
 * catalogue is wired against. The Responses API is still `(beta)` and
 * providers fill its envelope inconsistently (`output_text` unset on some).
 *
 * The transport itself - Tauri HTTP (CORS bypass), provider-selection policy,
 * and classified errors - is shared via `@/features/hf`'s
 * `routerChatCompletion`.
 */

export interface HfVlmProviderOptions {
  /** Late-bound HF token accessor. Called on every `describeScene`
   *  invocation so a token rotation mid-session (user signs out
   *  and back in) is picked up without rebuilding the provider.
   *  Returns `null` when no token is in sessionStorage; the
   *  provider then throws so the poller can skip this tick. */
  getHfToken: () => string | null;
  /** Model id. Defaults to `VISION_CONFIG.hfVlmModel`. The HF
   *  router accepts `<owner>/<model>` (auto-routes to fastest
   *  provider) or `<owner>/<model>:<provider>` to pin a specific
   *  backend. */
  model?: string;
}

export class HfVlmProvider implements VlmProvider {
  readonly name = "hf-router";

  private readonly getHfToken: () => string | null;
  private readonly model: string;

  constructor(opts: HfVlmProviderOptions) {
    this.getHfToken = opts.getHfToken;
    this.model = opts.model ?? VISION_CONFIG.hfVlmModel;
  }

  async describeScene(
    frame: CapturedFrame,
    opts: DescribeOptions,
  ): Promise<string> {
    const hfToken = this.getHfToken();
    if (!hfToken) {
      throw new Error("HfVlmProvider: no HF token in sessionStorage");
    }

    const prompt = buildPrompt(opts.userHint);

    // Wire the external abort signal (poller-driven) with a local
    // hard timeout. Whichever fires first cancels `fetch`.
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) controller.abort();
      else
        opts.abortSignal.addEventListener("abort", onExternalAbort, {
          once: true,
        });
    }
    const timer = window.setTimeout(
      () => controller.abort(),
      VISION_CONFIG.vlmRequestTimeoutMs,
    );

    try {
      // Single-model call: vision is multimodal, so we must NOT fall back
      // across the router's default TEXT instruct chain (those can't read an
      // image). `discover: false` skips the catalog GET on the vision hot
      // path (the poller runs this ~60x/hour). The router still applies the
      // provider-selection policy and raises a classified `HfRouterError` on
      // failure (caller's poller skips the tick on any throw).
      const response = await routerChatCompletion({
        baseModel: this.model,
        models: [this.model],
        discover: false,
        hfToken,
        signal: controller.signal,
        body: {
          max_tokens: 200,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: frame.dataUrl } },
              ],
            },
          ],
        },
      });

      const payload = (await response.json()) as VlmResponsePayload;
      const raw = extractText(payload);
      const description = sanitizeDescription(raw);
      if (!description) {
        // Diagnostic: an empty extraction is almost always one of
        //   (a) the model refused (content filter, "I can't see"),
        //   (b) the provider returned a shape we don't probe,
        //   (c) the model genuinely produced an empty string.
        // Dumping the truncated raw payload here is the cheapest
        // way to disambiguate without adding logging on the
        // success path (where we'd be hot-pathing a JSON.stringify
        // 60 times an hour).
        const rawJson = JSON.stringify(payload);
        console.warn(
          `[hf-vlm] empty description; raw payload: ${rawJson.slice(0, 400)}${
            rawJson.length > 400 ? "…" : ""
          }`,
        );
        throw new Error("HF VLM returned empty description");
      }
      return description;
    } finally {
      window.clearTimeout(timer);
      if (opts.abortSignal) {
        opts.abortSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }
}

/**
 * VLM response payload shape. We accept multiple legal variants
 * because the upstream providers (Hyperbolic, Together, Fireworks,
 * ...) have minor cosmetic differences in how they fill the
 * envelope. We probe in order of "most canonical first" and bail to
 * the next on a miss, so a quirky provider doesn't break the call.
 */
interface VlmResponsePayload {
  /** Canonical OpenAI Chat Completions shape (what we ask for). */
  choices?: Array<{
    message?: {
      /** The common case: a plain string. */
      content?: string | VlmContentPart[];
    };
  }>;
  /** Defensive fallback: some providers reply with the Responses
   *  API envelope even when posted to `/v1/chat/completions`. */
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}

/** A few providers structure `message.content` as an array of
 *  content parts rather than a string (mirrors the input shape).
 *  We accept both. */
interface VlmContentPart {
  type?: string;
  text?: string;
}

function extractText(payload: VlmResponsePayload): string {
  // 1. Canonical Chat Completions: choices[0].message.content as string.
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string" && content) {
    return content;
  }
  // 2. Same path but content-as-array (some providers mirror the
  //    input shape on the way out).
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        (part?.type === "text" || part?.type === "output_text") &&
        typeof part.text === "string" &&
        part.text
      ) {
        return part.text;
      }
    }
  }
  // 3. Responses-API fallback: a sticky provider may answer with
  //    the Responses envelope even at the Chat Completions URL.
  if (typeof payload.output_text === "string" && payload.output_text) {
    return payload.output_text;
  }
  const items = payload.output ?? [];
  for (const item of items) {
    const parts = item?.content ?? [];
    for (const part of parts) {
      if (
        (part?.type === "output_text" || part?.type === "text") &&
        typeof part.text === "string" &&
        part.text
      ) {
        return part.text;
      }
    }
  }
  return "";
}

/**
 * Build the per-call text prompt. Kept intentionally tight: the
 * shorter and more directive the prompt, the more reliably the VLM
 * produces a single factual sentence we can drop into the Realtime
 * context.
 */
function buildPrompt(userHint?: string): string {
  const base =
    "Describe what you see in this image in 1-2 short sentences. " +
    "Focus on: people, objects, environment, notable scene state. " +
    'Do NOT add caveats, opinions, or "I can see" prefixes. Just describe.';
  if (userHint && userHint.trim().length > 0) {
    const safeHint = userHint.replace(/[\r\n"]/g, " ").trim().slice(0, 240);
    return (
      base +
      `\nThe user just said: "${safeHint}". ` +
      "Bias your description toward what they likely care about."
    );
  }
  return base;
}

/**
 * Trim whitespace, strip leading "I can see" / "I see" prefixes the
 * VLM sometimes adds despite the prompt, and clamp the response to
 * `responseMaxChars`. Defensive safety net on top of
 * `max_output_tokens`.
 */
function sanitizeDescription(raw: string): string {
  let s = raw.trim();
  s = s.replace(
    /^(?:i\s+can\s+see|i\s+see|in\s+the\s+image|the\s+image\s+shows|here\s+is|here's)[,:]?\s+/i,
    "",
  );
  if (s.length > 0) {
    s = s[0].toUpperCase() + s.slice(1);
  }
  if (s.length > VISION_CONFIG.responseMaxChars) {
    s = s.slice(0, VISION_CONFIG.responseMaxChars).trimEnd() + "…";
  }
  return s;
}
