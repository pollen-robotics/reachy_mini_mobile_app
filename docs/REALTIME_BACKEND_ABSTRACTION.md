# Realtime backend - current state

Status: superseded plan, current-state note. Owner: `@tfrere`.

The original version of this document planned a temporary abstraction
between an OpenAI realtime bridge and a Hugging Face realtime bridge.
That migration has happened: the mobile app now uses the HF realtime
backend only, and the old OpenAI bridge/client/ephemeral-key path has
been removed.

## Current implementation

Read these files before touching the voice backend:

- `src/features/conversation/engine/conversation-engine.ts` - owns the
  conversation FSM, motion/audio/tool wiring, and instantiates the
  realtime bridge.
- `src/features/conversation/engine/bridge/huggingface-bridge.ts` -
  owns realtime session construction, output routing to the robot, tool
  response fan-out, mute, and reconnect behavior.
- `src/features/conversation/engine/huggingface-realtime.ts` - low-level
  websocket client for the HF realtime backend.
- `src/features/conversation/engine/hf-token.ts` - reads the signed-in
  user's HF token from storage.
- `src/features/conversation/engine/hf-voices.ts` - canonical voice
  catalog accepted by the backend.
- `src/shared/env.ts` and `.env.example` - runtime backend configuration.

The default path uses
`VITE_HF_REALTIME_CONNECTION_MODE=deployed` and allocates a websocket URL
through `VITE_HF_REALTIME_SESSION_PROXY_URL`. Local backend development
can switch to `local` and set `VITE_HF_REALTIME_WS_URL`.

## What not to reintroduce

- Do not add a generic provider registry while there is only one
  conversation backend.
- Do not restore OpenAI ephemeral-key minting in the mobile client.
- Do not add a shared credential abstraction for HF token access; the
  bridge owns that implementation detail.

## If a second backend appears

If we add another real voice backend later, create the abstraction at the
bridge boundary the engine already consumes:

- `connect(robotMicTrack)`
- `close()`
- `sendToolResponse(callId, result)`
- `setMicMuted(muted)`
- `isReconnecting()`
- `resetReconnectCounter()`
- `getRobotMicTrack(robot)`
- `getRealtimePort()`

Keep provider-specific auth and session allocation inside each bridge.
Add contract tests that assert status fan-out, tool response delivery,
mute, reconnect, and clean close behavior across both implementations.
