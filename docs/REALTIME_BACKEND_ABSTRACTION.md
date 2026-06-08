# Realtime backend abstraction

Status: **implemented**. Owner: `@tfrere`. Lives in
`src/features/conversation/engine/`.

The conversation's realtime LLM backend is **swappable at runtime**. The
engine talks to one interface (`RealtimeBackend`) and never to a concrete
provider. Two providers ship today - **Hugging Face** (default) and
**OpenAI** - and the user picks one from the conversation settings panel.

**Read this before touching any of:**

- `src/features/conversation/engine/realtime/types.ts` (the contract)
- `src/features/conversation/engine/realtime/index.ts` (the factory)
- `src/features/conversation/engine/bridge/huggingface-bridge.ts`
- `src/features/conversation/engine/bridge/openai-bridge.ts`
- `src/features/conversation/engine/conversation-engine.ts` (the single
  wiring point)

## Architecture

```
conversation-engine.ts
        │  depends on the interface only; reads the selected kind from
        │  conversation-settings and passes provider-agnostic deps
        ▼
  createRealtimeBackend(kind, deps)        ◀── realtime/index.ts (factory)
        │  injects provider auth here, never in the engine
   ┌────┴───────────────────┐
   ▼                        ▼
huggingface-bridge.ts   openai-bridge.ts
   │   getHfToken            │   getApiKey (mintEphemeralKey) + model
huggingface-realtime.ts  openai-realtime.ts
hf-token.ts              ephemeral-key.ts
```

All four bridge/client files satisfy the same `RealtimeBackend` contract.
`RealtimeStatusKind`, `RealtimeToolCallEvent`, `RealtimePort`,
`RealtimeBackendDeps` and `RealtimeBackend` are defined once in
`realtime/types.ts`; both bridges import them.

## The contract (`realtime/types.ts`)

`RealtimeBackendDeps` is the provider-agnostic deps the engine supplies
(`getRobot`, `voice`, `composeInstructions`, `tools?`, and the `on*`
callbacks). **Provider auth is intentionally NOT in it**: HF reads the
user's stored token, OpenAI mints a short-lived ephemeral key. Each
bridge extends the shared deps with its own credential:

```ts
interface HuggingFaceBridgeDeps extends RealtimeBackendDeps {
  getHfToken: () => string | null;
}
interface OpenaiBridgeDeps extends RealtimeBackendDeps {
  getApiKey: () => Promise<string>;
  model: string;
}
```

## The factory (`realtime/index.ts`)

```ts
export function createRealtimeBackend(
  kind: RealtimeBackendKind,
  deps: RealtimeBackendDeps,
): RealtimeBackend {
  switch (kind) {
    case "openai":
      return createOpenaiBridge({ ...deps, getApiKey: mintEphemeralKey, model: OPENAI_REALTIME_MODEL });
    case "huggingface":
      return createHuggingFaceBridge({ ...deps, getHfToken: readHfTokenFromStorage });
  }
}
```

The factory is the only place that injects provider auth. Adding a
provider = one `case` here + its bridge file. The engine is untouched.

## Selection (runtime)

The active provider is a persisted setting, not a build flag:

- Stored in `conversation-settings` (`realtimeBackend`, localStorage key
  `reachyMini.conversationSettings.realtimeBackend`), default
  `huggingface`.
- UI: a two-chip selector in `ConversationSettingsPanel`
  (`useRealtimeBackend` / `setRealtimeBackend`).
- The engine reads `getRealtimeBackend()` lazily at each (re)connect and
  passes it to the factory. The settings cog is disabled while a
  conversation is live, so a change always applies on the **next**
  conversation start - there is no live-swap path to reason about.

Optional build-time override of the OpenAI model:
`VITE_OPENAI_REALTIME_MODEL` (defaults to `gpt-realtime-2`).

## Provider notes

- **Hugging Face**: PCM over WebSocket. The user's HF token (from the
  OAuth flow, mirrored into `sessionStorage.hf_token`) authenticates the
  session directly via `readHfTokenFromStorage`.
- **OpenAI**: WebRTC. The phone never holds an OpenAI key; it POSTs its
  HF token to the website's `/api/openai/ephemeral` endpoint, which mints
  a ~10 min client secret (`ephemeral-key.ts`). That endpoint must be
  reachable for the OpenAI path to start.

## Dropping a provider (end state)

If a provider is ever retired, the change is mechanical and
self-contained:

- Delete its bridge + client (+ `ephemeral-key.ts` for OpenAI).
- Remove its `case` and its `RealtimeBackendKind` member.
- Drop its chip from `REALTIME_BACKENDS` in `ConversationSettingsPanel`.

No change to `conversation-engine.ts`, motion, vision, tools, or the FSM.
That isolation is the whole point.
