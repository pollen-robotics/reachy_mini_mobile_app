# Vision module - design specification

This document is the single source of truth for the **scene-awareness
feature** of the mobile app: a modular subsystem that periodically (and
on user demand) describes what the robot's camera sees, and feeds that
description back into the OpenAI Realtime conversation context so the
model can answer questions like "what's in front of you?", "describe
the room", or any utterance that benefits from visual grounding.

The module is intentionally designed as a **standalone, drop-in
feature**: it lives entirely under `src/conversation/vision/`, exposes
a single attach function to the conversation engine, and can be removed
in three line-edits without touching any other behaviour. The VLM
provider is **swappable** via configuration (OpenAI Vision today, HF
Inference SmolVLM scaffolded for tomorrow).

**Read it before touching any of:**

- `src/conversation/vision/**`
- `src/conversation/engine/conversation-engine.ts` (vision attach point)
- `src/conversation/engine/bridge/openai-bridge.ts` (RealtimePort export)
- `src/conversation/engine/openai-realtime.ts` (sendEvent visibility)

---

## 1. Goals and non-goals

### Goals

1. **Visual grounding for the conversation**: the model can answer
   "describe the scene", "what do you see?", "is there a coffee mug
   on the table?" without needing the user to bridge that gap
   manually.
2. **Modularity**: the entire feature lives in one folder; a single
   attach call wires it into the engine; a single removal sequence
   takes it out completely.
3. **Provider neutrality**: the choice of VLM (OpenAI gpt-4o-mini, HF
   SmolVLM, future local model, etc.) is a one-line config change.
4. **Predictable cost**: the feature must not blow up the Realtime
   API context (which would degrade the conversation itself) and must
   not generate runaway VLM bills.
5. **Non-invasive UX**: the model must NOT proactively narrate scene
   changes; visual context only surfaces when the user invites it.

### Non-goals (V1)

- Object detection / segmentation / tracking. We rely on a generic
  VLM caption, not a structured perception pipeline.
- Multi-frame reasoning (video understanding). Each capture is a still.
- Local on-device inference. V1 calls hosted APIs (OpenAI, HF
  Inference). A `local-vlm-provider` slot exists in the abstraction
  for a future Tauri plugin or transformers.js + WebGPU backend.
- UI controls (toggle, frequency dial, snapshot button). Configuration
  is build-time via env vars; runtime UI is a V2 concern.
- Memory persistence of observations across sessions. Observations
  live in the current Realtime context only.
- Tool-call style "let the model request a fresh look". The polling +
  STT-trigger combination already covers that need without giving the
  model another tool to misuse.

---

## 2. High-level architecture

```
                                       ┌────────────────────────┐
                                       │   Realtime API (OpenAI)│
                                       │  ┌────────────────┐    │
                              text only │  │  conversation  │    │
                          ┌─────────────│──│     context    │    │
                          │             │  └────────────────┘    │
                          │             └────▲───────────────────┘
                          │                  │
                          │                  │ user transcript
                          │                  │ (STT, completed)
                          │                  │
                          ▼                  │
                ┌──────────────────┐         │
                │  scene-injector  │         │
                └────────▲─────────┘         │
                         │                   │
                  describe(frame, hint)      │
                         │                   │
                ┌────────┴─────────┐ ┌───────┴─────────┐
                │   VlmProvider    │ │   stt-trigger   │
                │  (openai | hf)   │ │  keyword match  │
                └────────▲─────────┘ │  + debounce     │
                         │           └───────▲─────────┘
                  capture frame              │
                         │                   │
                ┌────────┴─────────┐         │ "regarde"
                │  frame-capture   │         │
                │ MediaStream → JPEG│        │
                └────────▲─────────┘         │
                         │                   │
        ┌────────────────┴───────────────────┴────────────────┐
        │                  scene-poller                       │
        │  - 30s interval                                     │
        │  - initial capture on conv start                    │
        │  - reset interval on STT trigger (no double-shot)   │
        │  - in-flight guard, skip if previous still pending  │
        └──────────────────────────────────────────────────────┘
                                │
                                │ getVideoStream()
                                ▼
                    ┌───────────────────────┐
                    │ conversation-engine   │
                    │ latestVideoStream     │
                    └───────────────────────┘
```

**Key insight**: nothing in the Realtime API path knows about images.
The Realtime API only ever sees **text** wrapped in
`<scene_observation>` tags. The VLM call is a side-channel that
produces those text descriptions. This is what makes the provider
swappable and what keeps the Realtime context bounded.

---

## 3. Module structure

```
src/conversation/vision/
├── index.ts                         # public façade: attachVision, types
├── config.ts                        # constants + env-driven flags
├── types.ts                         # shared TS types
├── prompt-fragment.ts               # system-prompt appendix
│
├── frame-capture.ts                 # MediaStream -> base64 JPEG (pure)
├── stt-trigger.ts                   # keyword match + debounce (pure)
├── scene-injector.ts                # text -> Realtime conversation.item.create
├── scene-poller.ts                  # orchestrator: timer + STT + provider + injector
│
└── providers/
    ├── types.ts                     # interface VlmProvider
    ├── openai-vlm-provider.ts       # gpt-4o-mini /v1/chat/completions
    ├── hf-vlm-provider.ts           # HF Inference SmolVLM (scaffold)
    └── factory.ts                   # createProvider(config) -> VlmProvider
```

Approximate sizes: ~450 lines total, all under `vision/`.

---

## 4. Data flow

### 4.1. Periodic tick (every 30s)

1. `scene-poller` timer fires.
2. Poller checks the in-flight guard. If a previous VLM call is still
   pending, this tick is skipped (no queueing, no parallel VLM calls
   for periodic ticks).
3. Poller calls `getVideoStream()` to read the engine's
   `latestVideoStream`. If `null` or the stream has no live video
   track, the tick logs a debug line and exits.
4. `frame-capture.captureFrame(stream)` returns a `CapturedFrame`
   (base64 JPEG, downscaled to 640px width, quality 0.7).
5. The poller calls `provider.describeScene(frame, { trigger: 'periodic' })`.
6. On success, `scene-injector.inject(text, 'periodic')` builds the
   Realtime event and sends it.
7. On failure (timeout, network, provider error), the tick logs and
   exits. No retry. Next tick will try again 30s later.

### 4.2. STT keyword trigger

1. Realtime API emits `conversation.item.input_audio_transcription.completed`.
2. The bridge forwards the transcript to `vision.onUserTranscript(text)`.
3. `stt-trigger` normalises the text (lowercase, strip diacritics) and
   checks it against the configured keyword list.
4. If a match is found AND no other STT trigger has fired in the past
   `triggerDebounceMs` (default 5s), the trigger callback fires.
5. The poller calls `frame-capture` immediately (no in-flight check
   here: user-initiated triggers always preempt). It then calls
   `provider.describeScene(frame, { trigger: 'stt_keyword', userHint: text })`.
6. The poller resets its periodic timer so the next periodic tick is
   30s from now (avoids back-to-back captures).
7. Result is injected via `scene-injector` with `trigger: 'stt_keyword'`.

### 4.3. Initial capture

When the conversation starts (`vision.start()`), the poller schedules
a first capture after `initialDelayMs` (default 1500ms) so the model
has visual context from message 1 onward, instead of being blind for
the first 30s. Treated identically to a periodic tick except for the
trigger label.

---

## 5. Public API

### 5.1. Attach point

```ts
// src/conversation/vision/index.ts

export interface RealtimePort {
  /** Send a raw client event to the OpenAI Realtime data channel. */
  sendEvent(event: Record<string, unknown>): void;
  /** Subscribe to completed user-side STT transcripts. */
  onUserTranscript(cb: (text: string) => void): () => void;
}

export interface VisionHandle {
  start(): void;
  stop(): void;
  dispose(): void;
}

export interface AttachVisionDeps {
  realtime: RealtimePort;
  getVideoStream: () => MediaStream | null;
}

/**
 * Wire the vision module to the conversation engine. Returns null when
 * the feature is disabled via config (so the engine can call methods
 * with `vision?.start()` without checking flags).
 */
export function attachVision(deps: AttachVisionDeps): VisionHandle | null;

/**
 * System-prompt fragment to append to the Realtime instructions.
 * Returns an empty string when the feature is disabled.
 */
export function getVisionPromptAppendix(): string;
```

That's the entire surface. Everything else is internal.

### 5.2. Provider interface

```ts
// src/conversation/vision/providers/types.ts

export type SceneTrigger = 'periodic' | 'stt_keyword' | 'initial';

export interface CapturedFrame {
  /** Data URL of the JPEG (`data:image/jpeg;base64,...`). */
  dataUrl: string;
  capturedAt: number;
  widthPx: number;
  heightPx: number;
}

export interface DescribeOptions {
  trigger: SceneTrigger;
  /** User utterance that triggered the capture (STT-trigger only). */
  userHint?: string;
  abortSignal?: AbortSignal;
}

export interface VlmProvider {
  readonly name: string;
  describeScene(frame: CapturedFrame, opts: DescribeOptions): Promise<string>;
}
```

A new provider is one file: implement the interface, register it in
`providers/factory.ts`, expose its config knobs in `config.ts`. No
other file in the module needs to change.

---

## 6. The VLM prompt

The prompt sent to the VLM is intentionally tight to keep the response
short, factual, and free of conversational fluff that would pollute
the Realtime context.

```
Describe what you see in this image in 1-2 short sentences.
Focus on: people, objects, environment, notable scene state.
Do NOT add caveats, opinions, or "I can see" prefixes. Just describe.
{userHint ? `\nThe user just said: "${userHint}". Bias your description toward what they likely care about.` : ''}
```

Expected output: 30-80 tokens. If a provider returns more than ~200
tokens, the poller truncates client-side as a safety net.

---

## 7. The Realtime context injection

The injector builds an OpenAI Realtime client event of the following
shape and sends it on the data channel:

```json
{
  "type": "conversation.item.create",
  "item": {
    "type": "message",
    "role": "user",
    "content": [
      {
        "type": "input_text",
        "text": "<scene_observation source=\"camera\" trigger=\"periodic\" timestamp=\"14:32:15\">\n{vlm description here}\n</scene_observation>"
      }
    ]
  }
}
```

Notes:

- Role is `"user"` because the Realtime API does not allow injecting
  arbitrary `system` items mid-conversation. The role-confusion is
  acceptable because the system prompt explicitly teaches the model
  what `<scene_observation>` blocks are and how to treat them.
- No `response.create` follow-up. We are adding context, not asking
  the model to speak. The model only reacts when the user actually
  says something.
- `timestamp` is local wall time, formatted `HH:MM:SS`. Cheap and
  useful for the model to differentiate "what you saw 5 minutes ago"
  from "what you see now".

---

## 8. The system-prompt appendix

`prompt-fragment.ts` exports:

```
You may receive periodic <scene_observation> messages with brief
descriptions of what your camera sees. They are PASSIVE background
context, not direct user requests.

- Do NOT narrate them unprompted ("oh, I see a cup now!").
- Only reference what you saw if the user asks ("what do you see?",
  "regarde", "describe the room") OR if it is directly and naturally
  relevant to what they just said.
- Trust the most recent observation; older ones may be stale.
- Observations come from your camera, so refer to them in first
  person ("I can see..."), not third person.
```

The conversation engine concatenates this to the base instructions in
`composeInstructions()`. When `VISION_CONFIG.enabled === false`,
`getVisionPromptAppendix()` returns `""` so the prompt is identical
to the pre-vision build.

---

## 9. STT trigger details

### Keywords (default list)

```ts
[
  'regarde',
  'regardes',
  'tu vois',
  'que vois-tu',
  'décris',
  'look',
  'see',
  'show me',
  'what do you see',
]
```

Matching rules:

- Lowercase + strip diacritics on both haystack and needles
  (so "Regarde !" matches "regarde", "décris" matches "decris").
- Whole-word match via word-boundary regex (so "regardé hier"
  doesn't match `regarde`).
- First-match-wins; we don't care which keyword triggered.

### Debounce

5s debounce on the trigger callback. If the user says "regarde,
regarde !" twice in 2s, only one VLM call fires. The debounce starts
on the **first** trigger (so the user sees a fast response) and
swallows subsequent triggers within the window.

### Why not stream deltas?

Realtime API also emits `transcription.delta` events for incremental
transcripts. We deliberately listen only to `completed`:

- Delta matching produces false positives: "regardé un film",
  "j'ai regardé hier".
- Latency saving is small (~500ms) and not worth the UX hit when the
  model starts fetching the wrong scene description.

V2 might add an opt-in delta path with stricter matching (regex
anchored at word start + lookahead for a verb-tense disambiguator).

---

## 10. Configuration

All knobs live in `src/conversation/vision/config.ts`. Env vars are
read at build time via Vite (`import.meta.env`).

```ts
export const VISION_CONFIG = {
  enabled: (import.meta.env?.VITE_VISION_ENABLED ?? 'true') !== 'false',
  provider: (import.meta.env?.VITE_VISION_PROVIDER ?? 'openai') as
    | 'openai'
    | 'hf'
    | 'none',

  // Polling
  intervalMs: 30_000,
  initialDelayMs: 1_500,

  // Capture
  imageMaxWidth: 640,
  imageQuality: 0.7,

  // STT trigger
  triggerKeywords: [
    'regarde', 'regardes', 'tu vois', 'que vois-tu', 'décris',
    'look', 'see', 'show me', 'what do you see',
  ],
  triggerDebounceMs: 5_000,

  // Provider OpenAI
  openaiVlmModel: import.meta.env?.VITE_VISION_OPENAI_MODEL ?? 'gpt-4o-mini',
  openaiVlmDetail: 'low' as const,

  // Provider HF (optional)
  hfVlmModel: import.meta.env?.VITE_VISION_HF_MODEL ?? 'HuggingFaceTB/SmolVLM-2.2B-Instruct',
  hfToken: import.meta.env?.VITE_HF_TOKEN ?? '',

  // Hygiene
  vlmRequestTimeoutMs: 8_000,
  responseMaxChars: 600,
};
```

### Env var reference

| Variable | Default | Effect |
|----------|---------|--------|
| `VITE_VISION_ENABLED` | `true` | `false` disables the entire feature; module returns no-op handle. |
| `VITE_VISION_PROVIDER` | `openai` | One of `openai` / `hf` / `none`. `none` is identical to disabling. |
| `VITE_VISION_OPENAI_MODEL` | `gpt-4o-mini` | Any OpenAI model that supports vision input. |
| `VITE_VISION_HF_MODEL` | `HuggingFaceTB/SmolVLM-2.2B-Instruct` | Any HF Inference-compatible VLM. |
| `VITE_HF_TOKEN` | `""` | Required when `VITE_VISION_PROVIDER=hf`. |

### Cost estimate (OpenAI gpt-4o-mini, detail: low)

| Trigger | Cadence | Tokens/call | $/hour |
|---------|---------|-------------|--------|
| Periodic | 1 / 30s | ~85 input + 60 output | ~$0.001 |
| STT trigger | bursty, capped 1/5s | same | <$0.001 |
| **Total** | active conversation | | **<$0.003 / hour** |

Negligible on top of the Realtime API audio cost (~$0.50-2/hour).

---

## 11. Lifecycle

### When does the poller run?

The poller is `start()`-ed by the engine **once the conversation is
fully active** (post wake-up trajectory, post handshake, post
`conversationStarted = true`). It is `stop()`-ped on:

- User-initiated stop (`requestStop()`)
- Session error / fatal disconnect
- Tab switch to the apps tab (the conv panel unmounts)
- App teardown / window close

`dispose()` releases all timers, removes the STT subscription, and
nulls internal references. After `dispose()` the handle is dead and
`start()` is a no-op.

### Idempotency

`start()`, `stop()`, `dispose()` are all idempotent. Calling
`start()` on a started poller is a no-op (no double timer).

### What happens during a transparent reconnect?

The OpenAI bridge does a one-shot transparent reconnect on transient
errors. During the reconnect window the `RealtimePort.sendEvent()`
call becomes a silent no-op (the bridge has no live client). The
poller's timer keeps ticking; the dropped tick is logged but not
retried. The next tick after reconnect delivers normally.

---

## 12. Standalone & removability

The module is designed to be removable in three line-edits:

### Removal procedure

```bash
# 1. Drop the module
rm -rf src/conversation/vision/
```

In `src/conversation/engine/conversation-engine.ts`:

```diff
- import { attachVision, getVisionPromptAppendix } from "./vision";
- ...
- const vision = attachVision({
-   realtime: openaiBridge.getRealtimePort(),
-   getVideoStream: () => latestVideoStream,
- });
- ...
- vision?.start();           // (in conversation-start path)
- ...
- vision?.dispose();         // (in cleanup path)
- ...
- // in composeInstructions:
- return basePrompt + memoryDigest + getVisionPromptAppendix();
+ return basePrompt + memoryDigest;
```

In `src/conversation/engine/bridge/openai-bridge.ts`, the
`getRealtimePort()` method and the `RealtimePort` interface can stay
(they are useful for any future side-channel module) or be removed
for cleanliness.

In `src/conversation/engine/openai-realtime.ts`, the `sendEvent`
method can revert to `private` if no other module uses it.

**No localStorage migration. No prompt rewrite. No env var cleanup
required.** The `VITE_VISION_*` env vars become dead config and are
silently ignored.

### What does NOT live in `vision/`

The module is self-contained EXCEPT for these intentional touch-points:

| File | Change | Why it stays | Removability cost |
|------|--------|--------------|-------------------|
| `openai-realtime.ts` | `sendEvent` made public | Can't send Realtime events without it | 1-line revert |
| `openai-bridge.ts` | `RealtimePort` + `getRealtimePort` | Generic side-channel hook for any future module (memory, telemetry, etc.) | optional cleanup |
| `conversation-engine.ts` | `attachVision`, `getVisionPromptAppendix`, prompt concat | The integration point | 4-line revert |

That is the entire blast radius.

---

## 13. Provider implementation notes

### OpenAI (gpt-4o-mini, default)

- Endpoint: `https://api.openai.com/v1/chat/completions`
- Auth: reuses the existing `VITE_OPENAI_API_KEY` from the engine
  settings (no separate key to provision).
- Image format: `data:image/jpeg;base64,...` URL passed in the
  `image_url` content part with `detail: "low"`.
- Timeout: 8s (`vlmRequestTimeoutMs`) via `AbortController`.
- Request shape (abbreviated):

```json
{
  "model": "gpt-4o-mini",
  "max_tokens": 200,
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "<the prompt above>" },
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,...", "detail": "low" } }
      ]
    }
  ]
}
```

### HF Inference (SmolVLM, scaffolded)

- Endpoint: `https://api-inference.huggingface.co/models/{model}`
- Auth: `Authorization: Bearer ${VITE_HF_TOKEN}`
- The HF Inference API for VLMs is in flux; the scaffold uses the
  generic image-to-text task signature and is marked as
  `// TODO: smoke test against current HF Inference API`.
- Cold-start (first request after model unload) can take 20-40s; the
  provider should emit a `console.warn` on slow first calls and the
  poller should treat the first HF call with a longer timeout (TODO).

### Adding a new provider

1. Create `providers/my-vlm-provider.ts` implementing `VlmProvider`.
2. Add the model knobs to `config.ts`.
3. Register in `providers/factory.ts`:

```ts
case 'my-vlm':
  return new MyVlmProvider(config);
```

4. Document the new `VITE_VISION_PROVIDER=my-vlm` value in this file.

That is it. No engine change, no bridge change, no prompt change.

---

## 14. Observability

The module logs at `console.info` / `console.debug` level on:

- Poller start / stop / dispose
- Tick scheduled / fired / skipped (with reason)
- Frame capture success / failure (with frame size)
- VLM call start / success (with latency, char count) / failure
- STT trigger detected (with matched keyword + debounce status)
- Injection sent (with first 80 chars of description)

All log lines are prefixed `[vision]` so they can be filtered in
DevTools with a single `[vision` regex.

No telemetry / external observability. If we ship a fleet-wide
observability layer later, the same prefixed logs can be tapped
without changing the module.

---

## 15. Limitations and open questions

### Known limitations

1. **No multi-frame reasoning.** Each capture is independent. The
   model cannot reason "this object moved from A to B" beyond what
   the per-frame text descriptions encode.
2. **VLM-induced bias.** The descriptions are at the mercy of the
   VLM's prompt-following. If the model adds "I can see..." prefixes
   despite our instruction, the Realtime model may parrot them.
3. **Camera offline = blind feature.** If the robot's camera fails
   mid-session, the model has no way to know other than ticks
   silently failing. We don't surface this to the user (yet).
4. **No backpressure on the model.** If the user spams "regarde,
   regarde, regarde" and the debounce drops triggers, the user has
   no signal that we ignored anything.
5. **HF provider is a scaffold.** Untested against the live HF
   Inference API. Marked clearly in code.

### Open questions (deferred to V2)

- Should we emit a small UI indicator ("eye icon" briefly visible
  when a capture is fresh) so the user has a sense of when the model
  has "looked"? Currently silent on purpose.
- Should we let the user toggle the feature at runtime from the
  conversation top bar? Currently build-time only.
- Should we cache the last description so back-to-back STT triggers
  reuse it? Avoids redundant VLM calls when the scene hasn't moved.
- Should we expose a `triggerNow()` method on the handle so the host
  can wire a manual snapshot button if/when one ships?
- Memory persistence: should we periodically summarise the last N
  observations and write the summary to `memoryStore`? Long-term
  spatial memory across sessions is a powerful UX win but a larger
  privacy / cost call.

---

## 16. Implementation order (1-shot V1)

For the implementer (or future re-implementer after a removal):

1. `config.ts` + `types.ts` + `prompt-fragment.ts` (foundations)
2. `frame-capture.ts` + manual smoke test in DevTools console
3. `providers/types.ts` + `openai-vlm-provider.ts` + isolated smoke test
4. `providers/factory.ts` + `hf-vlm-provider.ts` (stubbed)
5. Patches: `openai-realtime.ts` (`sendEvent` public), `openai-bridge.ts`
   (`RealtimePort` + `getRealtimePort`)
6. `scene-injector.ts` + `stt-trigger.ts`
7. `scene-poller.ts`
8. `index.ts` (façade) + patches in `conversation-engine.ts`
9. End-to-end test: start conv, wait 30s, ask "what do you see?",
   say "regarde devant toi", verify model responses are scene-relevant.

Estimated effort: ~2 hours focused work, including the e2e validation.

---

## 17. Quick reference

| What I want to do | Where to look |
|-------------------|---------------|
| Disable the feature | `VITE_VISION_ENABLED=false` in `.env.local` |
| Switch provider | `VITE_VISION_PROVIDER=hf` in `.env.local` |
| Change capture frequency | `VISION_CONFIG.intervalMs` in `config.ts` |
| Add a new keyword | `VISION_CONFIG.triggerKeywords` in `config.ts` |
| Tighten the VLM prompt | `getVlmPrompt()` in the provider file |
| Tweak the system-prompt appendix | `SCENE_OBSERVATION_INSTRUCTIONS` in `prompt-fragment.ts` |
| Add a new VLM provider | New file in `providers/`, register in `factory.ts` |
| Remove the entire feature | See section 12 |
