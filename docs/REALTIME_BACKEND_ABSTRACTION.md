> **Superseded.** The phone no longer talks to a realtime backend, so there is
> nothing left to abstract on this side. The robot's conversation app owns that
> choice now. Kept for the reasoning behind the backend seam, which moved with
> it.

# Realtime backend

Status: **implemented**. Owner: `@tfrere`. Lives in
`src/features/conversation/engine/`.

The conversation's realtime LLM backend is the **Hugging Face realtime
service**. The engine talks to one interface (`RealtimeBackend`) and
never to the concrete client, so the transport details stay isolated
behind a single seam.

> History: the app briefly shipped a second, opt-in OpenAI Realtime
> provider behind a runtime picker. That provider was removed - Hugging
> Face is now the sole backend. The `RealtimeBackend` interface is kept
> as a clean seam (it makes the engine agnostic of transport details and
> keeps the bridge independently testable), not as a multi-provider
> abstraction.

**Read this before touching any of:**

- `src/features/conversation/engine/realtime/types.ts` (the contract)
- `src/features/conversation/engine/realtime/backend-controller.ts`
  (builds the bridge + owns the vision side-channel)
- `src/features/conversation/engine/bridge/huggingface-bridge.ts`
- `src/features/conversation/engine/conversation-engine.ts` (the single
  wiring point)

## Architecture

```
conversation-engine.ts
        │  depends on the interface only; passes provider-agnostic deps
        ▼
createRealtimeBackendController(deps)   ◀── realtime/backend-controller.ts
        │  builds the bridge once + wires vision; injects the HF token
        ▼
huggingface-bridge.ts
        │  getHfToken (readHfTokenFromStorage)
huggingface-realtime.ts
hf-token.ts
```

`RealtimeStatusKind`, `RealtimeToolCallEvent`, `RealtimePort`,
`RealtimeBackendDeps` and `RealtimeBackend` are defined once in
`realtime/types.ts`; the bridge imports them.

## The contract (`realtime/types.ts`)

`RealtimeBackendDeps` is the provider-agnostic deps the engine supplies
(`getRobot`, `voice`, `composeInstructions`, `tools?`, and the `on*`
callbacks). **Provider auth is intentionally NOT in it**: the backend
controller injects the user's stored HF token into the bridge, so the
engine never has to know which credential the backend uses:

```ts
interface HuggingFaceBridgeDeps extends RealtimeBackendDeps {
  getHfToken: () => string | null;
}
```

## The controller (`realtime/backend-controller.ts`)

Builds the Hugging Face bridge once (injecting `readHfTokenFromStorage`
as its auth) and wires the vision side-channel onto it. It owns the
vision wiring - rather than the engine - because vision attaches to the
bridge's `RealtimePort`; keeping the build + attach in one place means
the engine can't forget to wire it.

## Provider notes

- **Hugging Face**: PCM over WebSocket. The user's HF token (from the
  OAuth flow, mirrored into `sessionStorage.hf_token`) authenticates the
  session directly via `readHfTokenFromStorage`.

## Voice selection

A persona pins a single synth voice (an HF Qwen3-TTS speaker id). The
engine reads the active persona's `voice` lazily on each (re)connect and
snaps it onto the HF catalog via `resolvePersonaVoice` (see
`features/personalities/builtin.ts`).
