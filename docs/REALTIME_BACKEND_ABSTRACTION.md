# Realtime backend abstraction - plan

Status: draft. Owner: `@tfrere`. Target implementation lives in
`src/features/conversation/engine/`.

This document is the single source of truth for making the conversation's
**realtime LLM backend swappable**: today the engine is hard-wired to
OpenAI Realtime; we want it to sit behind one thin boundary so that
Hugging Face realtime (Andi's backend, PR pollen-robotics/reachy_mini_mobile_app#48)
can run in parallel, and so OpenAI can later be deleted without touching
the conversation pipeline.

**Read this before touching any of:**

- `src/features/conversation/engine/conversation-engine.ts`
- `src/features/conversation/engine/bridge/openai-bridge.ts`
- `src/features/conversation/engine/openai-realtime.ts`
- `src/features/conversation/engine/ephemeral-key.ts`

## Goal

- The engine talks to **one interface** (`RealtimeBackend`), never to a
  concrete provider.
- Adding or removing a provider = adding/deleting one implementation file
  plus one `case` in a factory. Zero changes to the pipeline.
- End state: OpenAI is deletable in a single, self-contained PR.

## Non-goals (explicit anti over-engineering guardrails)

- **No** generic plugin registry / DI container. There are exactly two
  providers; a `switch` is enough. Revisit only if a third appears.
- **No** abstract `CredentialProvider` hierarchy. Each provider owns its
  auth internally (OpenAI mints an ephemeral key; HF calls a session
  allocator). Auth is an implementation detail, not a shared concept.
- **No** rewrite of `conversation-engine.ts`. We touch only the ~15 lines
  that wire the bridge. The god-object refactor is a separate effort.
- **Rule of thumb:** the interface is justified because it has **two real
  implementations running today**. If it ever has one, it is dead weight.

## Target architecture

```
conversation-engine.ts
        │  (depends on the interface only)
        ▼
  RealtimeBackend  ◀── interface (the named contract that the two
        ▲              bridges already satisfy de facto)
        │
  createRealtimeBackend(kind, deps)   ◀── factory, ~10 lines, switch
        │
   ┌────┴───────────────┐
   ▼                    ▼
openai-bridge.ts   huggingface-bridge.ts
   │                    │
openai-realtime.ts  huggingface-realtime.ts
ephemeral-key.ts    hf-token.ts
```

The boundary is the existing bridge surface. `OpenaiBridgeDeps` and
`HuggingFaceBridgeDeps` (PR #48) are already almost identical, so we are
**naming a contract that already exists**, not inventing one.

## The interface

Derived 1:1 from what `conversation-engine` consumes today. No new
concepts.

```ts
// src/features/conversation/engine/realtime/types.ts
export type RealtimeBackendKind = "openai" | "huggingface";

export interface RealtimeBackendDeps {
  getRobot: () => ReachyMiniInstance | null;
  voice: string | (() => string);
  composeInstructions: () => string;
  tools?: typeof ROBOT_TOOLS | (() => typeof ROBOT_TOOLS);
  onStatus: (status: RealtimeStatusKind) => void;
  onOutputTrack: (track: MediaStreamTrack) => void;
  onToolCall: (call: RealtimeToolCallEvent) => void;
  onReconnecting: () => void;
  onFatalError: (err: Error) => void;
}

export interface RealtimeBackend {
  connect: (robotMicTrack: MediaStreamTrack) => Promise<void>;
  close: () => Promise<void>;
  sendToolResponse: (
    callId: string,
    result: { ok: boolean; message: string },
  ) => boolean;
  setMicMuted: (muted: boolean) => void;
  isReconnecting: () => boolean;
  resetReconnectCounter: () => void;
  getRobotMicTrack: (robot: ReachyMiniInstance) => MediaStreamTrack | null;
  getRealtimePort: () => RealtimePort;
}
```

Provider-specific auth (`getApiKey` / ephemeral key vs `getHfToken` /
allocator) stays **inside** each bridge's `deps`, not in the shared
interface.

## The factory

```ts
// src/features/conversation/engine/realtime/index.ts
export function createRealtimeBackend(
  kind: RealtimeBackendKind,
  deps: RealtimeBackendDeps,
): RealtimeBackend {
  switch (kind) {
    case "huggingface":
      return createHuggingFaceBridge({ ...deps, getHfToken: readHfTokenFromStorage });
    case "openai":
      return createOpenaiBridge({ ...deps, getApiKey: mintEphemeralKey });
  }
}
```

Selection via `VITE_REALTIME_BACKEND` (`shared/env.ts`), default `openai`
until HF latency is validated on real hardware.

## Migration steps

1. Cherry-pick **only** the new HF files from PR #48:
   `huggingface-realtime.ts`, `bridge/huggingface-bridge.ts`,
   `hf-token.ts`, and their tests. Ignore the ~40 cosmetic-rename files,
   which conflict with in-flight personalities work.
2. Add `realtime/types.ts` (interface) and `realtime/index.ts` (factory).
3. Make both bridges return `RealtimeBackend` (type-only change; they
   already match).
4. In `conversation-engine.ts`, replace the direct `createOpenaiBridge`
   call with `createRealtimeBackend(REALTIME_BACKEND, deps)`. This is the
   only pipeline edit.
5. Add `VITE_REALTIME_BACKEND` to `shared/env.ts` + `.env.example`.

## OpenAI removal (end state)

When HF is validated and we drop OpenAI, the PR is mechanical and
self-contained:

- Delete `bridge/openai-bridge.ts`, `openai-realtime.ts`,
  `ephemeral-key.ts`.
- Remove the `"openai"` case + the `RealtimeBackendKind` union member.
- Remove the `/api/openai/ephemeral` reference from `.env.example`.

No change to `conversation-engine.ts`, motion, vision, tools, or the FSM.
That isolation is the whole point of this plan.

## Testing

- Reuse the bridge mock pattern from `huggingface-bridge.test.ts`.
- One shared spec asserting both bridges honor the `RealtimeBackend`
  contract (status fan-out, tool response, mute, reconnect-once).
- Keep provider-specific tests (URL normalization, session config) local
  to each provider.

## Risks

- HF transports PCM over WebSocket (no native WebRTC jitter buffer); the
  manual scheduling/drain in `huggingface-realtime.ts` must hold on
  degraded mobile networks. Validate before flipping the default.
- HF realtime is younger than `gpt-realtime-2`; keep OpenAI as the default
  until measured parity.
