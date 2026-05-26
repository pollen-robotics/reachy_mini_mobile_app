/**
 * OpenAI Vision provider (default).
 *
 * Hits the regular Chat Completions endpoint with an `image_url`
 * content part. We deliberately don't reuse the Realtime WebRTC pipe
 * (no image support there yet) - a separate HTTPS round-trip is the
 * cheapest path and keeps the Realtime context bounded to plain text.
 *
 * Historically reused the engine's build-time `VITE_OPENAI_API_KEY`
 * via the `apiKey` ctor argument. The mobile shell no longer
 * carries a long-lived OpenAI key (see
 * `features/conversation/engine/ephemeral-key.ts`), so the
 * provider is currently inert: the engine passes `openaiApiKey: ''`
 * and `attachVision` returns null. Re-enabling requires either a
 * server-side proxy for `/v1/chat/completions` or switching to a
 * Hugging Face Inference Providers route. See the comment block
 * in `conversation-engine.ts` next to the `attachVision` call.
 */

import { VISION_CONFIG } from "../config";
import type { CapturedFrame, DescribeOptions } from "../types";
import type { VlmProvider } from "./types";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

export interface OpenaiVlmProviderOptions {
  /** OpenAI API key. The engine currently passes an empty string,
   *  which makes `attachVision` short-circuit to a no-op. Kept on
   *  the API for the eventual server-proxied / HF-Inference
   *  re-enablement. */
  apiKey: string;
  /** Model id. Defaults to `VISION_CONFIG.openaiVlmModel`. */
  model?: string;
}

export class OpenaiVlmProvider implements VlmProvider {
  readonly name = "openai";

  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts: OpenaiVlmProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? VISION_CONFIG.openaiVlmModel;
  }

  async describeScene(
    frame: CapturedFrame,
    opts: DescribeOptions,
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error("OpenaiVlmProvider: missing API key");
    }

    const prompt = buildPrompt(opts.userHint);

    // Wire the external abort signal (poller-driven) with a local
    // hard timeout. Whichever fires first cancels `fetch`.
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) controller.abort();
      else opts.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer = window.setTimeout(
      () => controller.abort(),
      VISION_CONFIG.vlmRequestTimeoutMs,
    );

    try {
      const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: 200,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "image_url",
                  image_url: {
                    url: frame.dataUrl,
                    detail: VISION_CONFIG.openaiVlmDetail,
                  },
                },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `OpenAI VLM call failed (${response.status}): ${text.slice(0, 200)}`,
        );
      }

      const payload = (await response.json()) as ChatCompletionsResponse;
      const raw = payload.choices?.[0]?.message?.content ?? "";
      const description = sanitizeDescription(raw);
      if (!description) {
        throw new Error("OpenAI VLM returned empty description");
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

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
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
 * `responseMaxChars`. Defensive safety net on top of `max_tokens`.
 */
function sanitizeDescription(raw: string): string {
  let s = raw.trim();
  // Strip a handful of canonical openings. Case-insensitive, only
  // matches at the very start so legitimate uses mid-sentence are
  // preserved.
  s = s.replace(
    /^(?:i\s+can\s+see|i\s+see|in\s+the\s+image|the\s+image\s+shows|here\s+is|here's)[,:]?\s+/i,
    "",
  );
  // Capitalise the first letter again after a strip so the line still
  // reads cleanly when the model's continuation started lowercase.
  if (s.length > 0) {
    s = s[0].toUpperCase() + s.slice(1);
  }
  if (s.length > VISION_CONFIG.responseMaxChars) {
    s = s.slice(0, VISION_CONFIG.responseMaxChars).trimEnd() + "…";
  }
  return s;
}
