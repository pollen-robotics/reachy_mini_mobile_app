# Conversation module architecture - target design

Status: draft. Owner: `@tfrere`. Implementation lives in
`src/features/conversation/`.

This document defines how the **conversation feature** is decomposed into
a clean, well-bounded module: a pure core, narrow ports, swappable
adapters, and a thin orchestrator. It complements
[`REALTIME_BACKEND_ABSTRACTION.md`](./REALTIME_BACKEND_ABSTRACTION.md),
which covers the LLM-transport port specifically.

The driving goal: the conversation loop should be **a real module with
clear seams**, testable brick by brick, where any single piece (backend,
robot transport, motion, vision) can be replaced without touching the
rest.

## What "best practice mid-2026" actually means here

Distilled from current production guidance for realtime voice agents
(OpenAI Agents SDK voice layer, the Pipecat/LiveKit frame-pipeline
school, the "Enterprise Realtime Voice Agents" tutorial, agentos voice
pipeline). The convergent, non-fashion patterns:

1. **Event-driven conversation state machine.** The loop is a finite
   state machine `idle → listening → processing → speaking`, plus an
   explicit **`interrupting`** state for barge-in. Every transition is a
   single, observable event.
2. **Barge-in is a first-class state, not a side effect.** When the user
   speaks over the agent, the system must, within ~200ms: stop playback,
   flush the output buffer, cancel the in-flight response. This deserves
   its own state and its own code path.
3. **Ports & adapters (hexagonal).** Keep every external dependency
   (LLM transport, robot, motion, vision) behind a **deliberately narrow
   interface** so implementations swap without touching the orchestrator.
   This is the same idea as the SDK's `RealtimeModel` transport
   abstraction (WebRTC / WebSocket / SIP).
4. **EventEmitter session boundaries.** Cross-boundary I/O fans out via
   listeners, keeping the hot path non-blocking. We already do this
   (`client.on(...)` in the bridges); keep it.
5. **Orchestrator depends only on abstractions.** The engine is wired
   with injected collaborators, so it can be unit-tested against fakes
   with no robot, no network, no audio hardware.

### What we explicitly do NOT adopt (anti over-engineering)

- **No XState / RxJS dependency.** We already have a small, typed,
  hand-rolled FSM (`engine-core/fsm.ts` + `gate.ts`) that is trivially
  testable. A statechart library is justified only if the machine grows
  hierarchical/parallel regions we can't express cleanly. Revisit then,
  not now.
- **No port where there is one implementation AND no test seam need.**
  An interface earns its place by having either (a) two real
  implementations, or (b) a need to fake it to test the orchestrator.
  Nothing else gets an interface.
- **No generic plugin registry / DI container.** Plain factories and an
  injected deps object.

## Current state (honest)

Already well-factored and reusable:

- `engine-core/{fsm,gate}.ts` - pure FSM + boolean gates.
- `motion-control/orchestrator.ts` (+ pose-dispatcher, wobbler, antennas)
  - cohesive motion subsystem.
- `vision/` - the **reference example**: `VlmProvider` port + factory +
  `RealtimePort` side-channel. Fully swappable and isolated.
- `tools/tool-call-handler.ts` - tool dispatch decoupled via injected
  `sendToolResponse`.
- `bridge/openai-bridge.ts` - already a transport adapter shape.

The problem - a single god-object:

- `engine/conversation-engine.ts` is **1758 lines** in one
  `mountConversation()` closure: boot, FSM subscribers, the turn
  pipeline (`runConversationParts`), motion wiring, vision wiring,
  teardown, orb handlers, instruction composition - all inline, no
  injection, hard to test.

So the work is **not** "rebuild the module"; it is "extract the
orchestrator's responsibilities into named, injected collaborators and
make the state machine + barge-in explicit".

## Target layout

```
features/conversation/
  core/                      # pure, no I/O, 100% unit-testable
    conversation-machine.ts  # FSM: states, transitions, barge-in
    phases.ts                # derivePhase (moved from robot-session)
    instructions.ts          # composeInstructions(inputs) -> string (pure)
    types.ts
  ports/                     # interfaces only (the contracts)
    realtime-backend.ts      # LLM transport  [see backend doc]
    robot.ts                 # wake/sleep, mic track, speaker routing
    motion.ts                # pose / wobble / antennas
    memory.ts                # remember / forget
    vision.ts                # VlmProvider (exists)
    tools.ts                 # tool registry
  adapters/                  # implementations of the ports
    realtime/
      openai/                # openai-bridge + openai-realtime + ephemeral-key
      huggingface/           # hf-bridge + hf-realtime + hf-token
      index.ts               # createRealtimeBackend(kind, deps)
    robot/robot-session-adapter.ts
    motion/motion-adapter.ts
    memory/local-storage-memory.ts
    vision/hf-vlm-adapter.ts
  orchestrator/              # the thin engine - depends only on ports
    conversation-orchestrator.ts
    turn-pipeline.ts         # runConversationParts, decomposed + named
    tool-dispatch.ts
    teardown.ts
  app/                       # React boundary
    useConversation.ts       # (today: useRobotSession)
    host-handle.ts
  index.ts                   # public surface (types + lifecycle only)
```

This keeps the subsystems that are already good (`motion-control`,
`vision`, `engine-core`) and relocates them under `core`/`adapters` as
the natural fit. It is a **reorganization + extraction**, not a rewrite.

## The conversation state machine

States (superset of today's `RealtimeStatus`, mapped to the canonical
loop):

```
            ┌─────────┐
            │  idle   │
            └────┬────┘
       connect() │
            ┌────▼──────┐
            │ connecting│
            └────┬──────┘
                 │ ready
            ┌────▼──────┐   user speaks    ┌──────────────┐
   ┌───────│ listening │─────────────────▶│ userSpeaking │
   │       └────▲──────┘                  └──────┬───────┘
   │            │ response done / drained        │ endpoint
   │       ┌────┴──────┐                  ┌──────▼──────┐
   │       │ speaking  │◀─── audio ───────│ processing  │
   │       └────┬──────┘                  └─────────────┘
   │  user barges in │
   │       ┌────▼────────┐
   └───────│ interrupting│  (flush playback, cancel response)
           └─────────────┘
  any state ─────────────▶ error / closed
```

Key point vs today: **`interrupting` becomes explicit**. It owns the
barge-in protocol (stop the output track, flush the PCM/WebRTC playback
buffer, send the cancel event to the backend) instead of relying on the
backend's implicit `interrupt_response`. This is exactly the gap the
in-flight playback-flush work targets (conversation-app #386,
reachy_mini #1186), so the FSM is where it belongs.

The machine stays a pure reducer: `(state, event) -> state` with side
effects expressed as commands the orchestrator runs. Keep using
`engine-core/fsm.ts`; just give it a named, documented transition table
and event union instead of ad-hoc `setState` calls scattered in the
closure.

## The ports

Narrow on purpose. The orchestrator imports only these.

```ts
// ports/realtime-backend.ts  -> two real impls (OpenAI, HF) => a true port
export interface RealtimeBackend { /* see backend abstraction doc */ }

// ports/robot.ts  -> one impl, but faked in orchestrator tests
export interface RobotPort {
  wakeUp(): Promise<void>;
  sleepAndDisable(): Promise<void>;
  getMicTrack(): MediaStreamTrack | null;
  routeSpeaker(track: MediaStreamTrack): void;
}

// ports/motion.ts
export interface MotionPort {
  startSession(): void;
  onUserSpeak(): void;
  applyPose(pose: HeadPose): void;
  stop(): void;
}

// ports/memory.ts
export interface MemoryPort {
  remember(fact: string): void;
  forget(query: string): void;
  snapshot(): string[];
}

// ports/tools.ts
export interface ToolRegistry {
  descriptors(): RealtimeTool[];
  dispatch(call: ToolCall): Promise<ToolResult>;
}
```

Honesty about which are "real" ports vs "test seams":

- `RealtimeBackend`, `VlmProvider` = **real ports** (polymorphic today),
  get a factory.
- `RobotPort`, `MotionPort`, `MemoryPort`, `ToolRegistry` = **single
  implementation**; the interface exists only so the orchestrator is
  testable with fakes. No factory, no registry, no ceremony.

## The orchestrator (thin)

`conversation-orchestrator.ts` replaces the god-object's
responsibilities. It receives all collaborators as one injected deps
object and does four things only:

1. Owns the `ConversationMachine` and subscribes UI/transport callbacks
   to its transitions.
2. Runs the **turn pipeline** (`turn-pipeline.ts`): the decomposed,
   named version of `runConversationParts` (mint creds → get mic track →
   start monitors → start motion → backend.connect → route speaker →
   release phone mic → start vision).
3. Routes backend events to FSM transitions and to `tool-dispatch.ts`.
4. Owns `teardown.ts` (single, ordered shutdown of the pipeline).

```ts
export function createConversationOrchestrator(deps: {
  backend: RealtimeBackend;
  robot: RobotPort;
  motion: MotionPort;
  memory: MemoryPort;
  vision?: VlmProvider;
  tools: ToolRegistry;
  machine: ConversationMachine;
  composeInstructions: (ctx: InstructionContext) => string;
}): ConversationOrchestrator { /* ... */ }
```

Because every dependency is an interface, the orchestrator's whole
behavior (turn sequencing, barge-in, reconnect, teardown order) becomes
unit-testable with in-memory fakes - which is the testability win the
module lacks today.

## Testability story (the actual payoff)

| Brick | How it's tested |
|-------|-----------------|
| `conversation-machine` | pure reducer: feed event sequences, assert state + emitted commands (incl. barge-in) |
| `instructions` | pure: given personality/memory/vision/language, assert prompt |
| `turn-pipeline` | orchestrator + fakes: assert call order, failure handling |
| `tool-dispatch` | fake `ToolRegistry`, assert dispatch + `sendToolResponse` |
| adapters (openai/hf/robot/...) | thin; contract test shared across realtime adapters |

Shared contract test: one spec both realtime adapters must pass
(status fan-out, tool response, mute, reconnect-once, clean close).

## Migration (incremental, never a big-bang)

Each step compiles, ships, and is independently revertable.

1. **Backend port** (per the backend doc): interface + factory, both
   bridges behind it. Smallest seam, highest leverage.
2. **Extract `instructions.ts`** as a pure function (today inline in the
   closure). Pure, easy, unblocks testing prompt logic.
3. **Extract `turn-pipeline.ts`** from `runConversationParts`, keep
   calling it from the closure. Behavior-preserving.
4. **Introduce `ConversationMachine`** with a named transition table;
   replace scattered `setState` calls. Add the explicit `interrupting`
   state + barge-in command.
5. **Wrap collaborators as ports** (`RobotPort`, `MotionPort`,
   `MemoryPort`, `ToolRegistry`) and inject them.
6. **Promote the closure to `conversation-orchestrator.ts`**; the
   `mountConversation()` boot path becomes a thin factory + wiring.
7. **Relocate files** into `core/ ports/ adapters/ orchestrator/ app/`
   and tighten `index.ts` to types + lifecycle only.

Steps 1-4 already deliver most of the testability gain; 5-7 are the
structural finish and can lag without blocking the backend work.

## Out of scope

- Speech-to-speech vs cascaded STT/LLM/TTS choice: we use a single
  realtime transport (OpenAI / HF); the cascaded-pipeline literature
  informs the *orchestration* patterns, not the transport.
- Server-side / daemon changes (playback flush lives partly in the
  robot backend; track it there).

## References (mid-2026)

- OpenAI Agents SDK - Voice Agents (RealtimeAgent / RealtimeSession /
  RealtimeModel transport adapter; ports & adapters for transport).
- "Building Enterprise Realtime Voice Agents from Scratch" (arXiv
  2603.05413) - cascaded streaming pipeline, VAD state machine.
- Chanl - "Voice Agent Platform Architecture" - barge-in as a state
  machine, sub-200ms interruption, semantic endpointing.
- agentos `voice-pipeline` - narrow swappable interfaces, EventEmitter
  session boundaries, `idle/listening/processing/speaking/interrupting`.
- XState v5 actor model - considered and deferred (see anti
  over-engineering).
