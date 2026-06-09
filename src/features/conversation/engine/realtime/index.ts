/**
 * Realtime backend factory.
 *
 * The single place that maps a `RealtimeBackendKind` to a concrete
 * bridge. Adding a provider = one `case` here + its bridge file; the
 * conversation engine stays untouched (it only ever sees the
 * `RealtimeBackend` contract).
 *
 * Provider auth is injected HERE, not by the engine: HF reads the user's
 * stored token, OpenAI mints a short-lived ephemeral key. The engine
 * passes only the provider-agnostic `RealtimeBackendDeps`.
 */

import { createHuggingFaceBridge } from "../bridge/huggingface-bridge";
import { createOpenaiBridge } from "../bridge/openai-bridge";
import { mintEphemeralKey } from "../ephemeral-key";
import { readHfTokenFromStorage } from "../hf-token";
import type {
  RealtimeBackend,
  RealtimeBackendDeps,
  RealtimeBackendKind,
} from "./types";

/**
 * OpenAI Realtime model id. `gpt-realtime-2` is the GA, reasoning-capable
 * Realtime model the mint endpoint also pins server-side. Overridable for
 * future setups without a rebuild.
 */
const OPENAI_REALTIME_MODEL =
  (import.meta.env?.VITE_OPENAI_REALTIME_MODEL as string | undefined) ??
  "gpt-realtime-2";

export function createRealtimeBackend(
  kind: RealtimeBackendKind,
  deps: RealtimeBackendDeps,
): RealtimeBackend {
  switch (kind) {
    case "openai":
      return createOpenaiBridge({
        ...deps,
        getApiKey: mintEphemeralKey,
        model: OPENAI_REALTIME_MODEL,
      });
    case "huggingface":
      return createHuggingFaceBridge({
        ...deps,
        getHfToken: readHfTokenFromStorage,
      });
  }
}

export type {
  RealtimeBackend,
  RealtimeBackendDeps,
  RealtimeBackendKind,
} from "./types";
