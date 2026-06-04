# Personality "Test Drive" - deferred feature

Status: **deferred / backlog**. Captured here while we ship the
"generate a personality from one sentence" feature so the idea is not
lost.

## What it is

In the create/edit personality flow (`CreatePersonalityModal.tsx`), let
the user preview how the persona behaves *before* committing it, so
authoring a personality stops being a blind "write a prompt and hope".

Two possible flavours:

1. **Text test-drive (cheap, self-contained)**
   A "Try it" button sends 1-2 canonical user prompts (e.g.
   "Hello, who are you?", "What can you do?") to the HF Inference
   Providers router using the *current* `instructions` as the system
   prompt, and renders the replies as chat bubbles inside the modal.
   The user reads the tone instantly. Voice choice stays visible through
   the existing HF voice descriptions.

2. **Voice test-drive (richer, needs server work)**
   Actually speak a generated line in the persona's chosen HF realtime
   voice.

## Why it is deferred

- The **text** flavour is easy and reuses the exact pattern we are
  introducing for generation (HF router `chat/completions` +
  `readHfTokenFromStorage()` + `tauriFetch`). It was cut only to keep
  the current change focused on generation.
- The **voice** flavour is *not* trivial today:
  - There is no standalone TTS endpoint available to the app. The
    realtime session allocator returns a conversation websocket URL, not
    a reusable text-to-speech API.
  - The old pre-recorded voice samples were removed with the HF voice
    migration, so the create/edit form cannot audition arbitrary
    generated text locally.
  - Speaking generated text in a specific HF voice would require either
    a small server-side TTS proxy or a dedicated HF realtime/TTS preview
    endpoint with per-user rate limiting.

## Suggested implementation when picked up

### Text test-drive (recommended first step)

- Reuse the generation module's HF router call path (see
  `features/personalities/generate.ts`).
- Add a `testDrivePersonality(instructions: string, prompts: string[])`
  helper returning the model replies.
- In `CreatePersonalityModal.tsx`, add a "Try it" affordance near the
  instructions field; render replies as lightweight chat bubbles.
- Guard on `instructions.trim().length > 0`; show loading + error
  states like the generation block.

### Voice test-drive (later, multi-repo)

- Add a server endpoint on the Reachy Mini API Space that proxies TTS
  (HF Inference, or the realtime backend if it exposes a preview API)
  authenticated by the user's HF token, with per-user rate limiting.
- Client: play the returned audio in the selected voice for a generated
  sample line.

## Pointers

- Auth/token source: `features/conversation/engine/hf-token.ts`
  (`readHfTokenFromStorage()`).
- HF router call pattern + CORS-bypass via `@tauri-apps/plugin-http`:
  `features/conversation/vision/providers/hf-vlm-provider.ts`.
- Tauri capability already allows `https://router.huggingface.co/*`
  (`src-tauri/capabilities/default.json`).
- Voices catalogue: `features/personalities/builtin.ts`
  (`AVAILABLE_VOICES`, `VOICE_DESCRIPTIONS`).
