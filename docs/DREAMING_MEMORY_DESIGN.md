# Dreaming Memory — Design & Implementation Plan

> **Status**: Proposal / RFC
> **Scope**: Mobile app (`reachy_mini_mobile_app`), with a view to extracting a standalone TS library later.
> **Origin**: TypeScript port of Rémi Fabre's "dreaming memory" architecture from
> [`reachy_mini_conversation_app` PR #360](https://github.com/pollen-robotics/reachy_mini_conversation_app/pull/360)
> (issue #295). Co-designed with Rémi.

---

## 1. Goals & non-goals

### Goals
- Port the dreaming-memory vision to TypeScript: atomic memory files, a dreamer LLM,
  recall tools, and a curated prompt-injected index.
- Keep the core **100% environment-agnostic** (no app / Tauri / React / OpenAI imports),
  testable without a browser.
- Expose injectable **ports** (storage + LLM) so the same core powers the mobile app today
  and a shareable library tomorrow.
- **Format interop with the Python implementation** (same `.md` + frontmatter) so memories
  can be exchanged between the robot-side app and the mobile app.

### Non-goals (v1)
- No vector DB — substring scoring only (validated by the Letta Filesystem benchmark:
  74% LoCoMo with flat files, beating vector-DB approaches).
- No mid-conversation dreaming — boot / inter-session only.
- No multi-user scoping — one device = one memory.

---

## 2. Background: why this approach

The mobile app already ships a simpler memory (`features/conversation/engine/memory.ts`):
a flat list of facts the model writes via the `remember` / `forget` tools, stored in
`localStorage`, injected verbatim into the prompt.

PR #360 deliberately moves away from that model:

> `save_memory` is removed. Memory creation is the dreamer's job.

Three strictly separated phases:
1. **Live conversation** — converse, append transcripts to the current session log, read
   memory via recall tools.
2. **Dreaming** — a second LLM (the "dreamer") runs between sessions, turning raw logs into
   atomic memory files and rebuilding the index. Never runs during a conversation.
3. **Recall** — the curated index is always in the system prompt; recall tools fetch details
   on demand.

Benchmark rationale: on LongMemEval 2026, naive write-time extraction memory (Mem0, 49%)
performs *worse* than plain full-context (60%). File-based "grep-style" memory with
sleep-time consolidation (the Letta pattern) is current state of the art and needs zero
infrastructure — a good fit for a backend-less Tauri app.

---

## 3. Architecture: ports & adapters

```
features/conversation/memory/
├── core/          AGNOSTIC — extractable as-is into a package
│   ├── types.ts
│   ├── frontmatter.ts
│   ├── memory-store.ts
│   ├── session-log.ts
│   ├── index-renderer.ts
│   ├── dreamer.ts
│   └── recall.ts
├── ports/         CONTRACTS (interfaces)
│   ├── storage.ts
│   └── llm.ts
├── adapters/      APP-SPECIFIC — stays in the app on extraction
│   ├── storage-tauri-fs.ts
│   ├── storage-localstorage.ts
│   └── llm-hf-router.ts
└── index.ts       facade: createMemory({ storage, llm, config })
```

**Dependency rule**: `core/ -> ports/` only. `adapters/ -> ports/`. App -> `index.ts`.
Never `core/ -> adapters/`.

---

## 4. Data model (faithful to PR #360)

### 4.1 On-disk layout (relative paths, via the storage port)

```
memory/
├── active_memory.md          # rendered index, injected into the prompt
├── memories/
│   └── YYYY-MM-DD_<slug>_<hex3>.md
└── logs/
    ├── pending/              # live + not-yet-dreamed logs
    └── processed/            # already dreamed
```

### 4.2 Memory file (`memories/*.md`)

```markdown
---
id: 2026-05-31_chess-openings_a3f
created: 2026-05-31T14:32:10Z
sources: [2026-05-30_09-15.log]
kind: preference          # fact | preference | event | skill | relationship | goal | other
tags: [chess, openings]   # tags[0] = primary (drives index grouping)
related_to: []
pinned: false
supersedes: null
superseded_by: null
---

Body, 150-250 tokens, chosen by the dreamer (quote, paraphrase, or justified synthesis).
```

### 4.3 Session log (`logs/pending/YYYY-MM-DD_HH-MM.log`)

```
--- session 2026-05-31 14:32 UTC ---

14:32:00 user: Hi, my name is Rémi
14:32:02 assistant: Nice to meet you, Rémi!
14:32:03 tool: play_move({"name":"happy"}) -> {"ok":true}
```

Append-only. Created lazily on first append (boots without conversation leave nothing behind).

---

## 5. Ports (contracts)

```ts
// ports/storage.ts
export interface StorageAdapter {
  read(path: string): Promise<string | null>;            // null when absent
  writeAtomic(path: string, content: string): Promise<void>; // temp + rename
  append(path: string, line: string): Promise<void>;
  list(dir: string): Promise<string[]>;                  // file names, sorted
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
```

```ts
// ports/llm.ts
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}
export interface ToolCall { id: string; name: string; args: Record<string, unknown>; }
export interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

export interface LLMClient {
  /** One chat turn with tool calling. The dreamer loops over this itself. */
  complete(req: {
    system: string;
    messages: ChatMsg[];
    tools: ToolSpec[];
  }): Promise<{ text: string; toolCalls: ToolCall[] }>;
}
```

The core only ever depends on these two interfaces.

---

## 6. Core modules

### 6.1 `core/types.ts`

```ts
export type Kind =
  | "fact" | "preference" | "event" | "skill" | "relationship" | "goal" | "other";

export interface Frontmatter {
  id: string;
  created: string;       // ISO UTC
  sources: string[];
  kind: Kind;
  tags: string[];        // tags[0] = primary (drives index grouping)
  related_to: string[];
  pinned: boolean;
  supersedes: string | null;
  superseded_by: string | null;
}
export interface Memory { id: string; frontmatter: Frontmatter; body: string; }
```

### 6.2 `core/frontmatter.ts`

Direct port of `frontmatter.py`. Minimal parser (the format is constrained and we write it
ourselves) — avoid a heavy YAML dependency.

```ts
export function parseFrontmatter(text: string): { meta: Partial<Frontmatter>; body: string };
export function dumpFrontmatter(meta: Frontmatter, body: string): string;
```

Tests: round-trip, list values, `null` fields, multi-line body, corrupted input degrades gracefully.

### 6.3 `core/memory-store.ts`

Port of `MemoryManager` CRUD + search. All I/O via `StorageAdapter`.

```ts
export class MemoryStore {
  constructor(private storage: StorageAdapter) {}

  private static ID_RE = /^\d{4}-\d{2}-\d{2}_[a-z0-9][a-z0-9_-]*_[0-9a-f]{3}$/;

  read(id: string): Promise<Memory>;
  exists(id: string): Promise<boolean>;
  write(id: string, body: string, fm: Omit<Frontmatter, "id" | "created">): Promise<void>;
  update(id: string, patch: { body?: string; frontmatter?: Partial<Frontmatter> }): Promise<void>;

  list(opts?: { tag?: string; kind?: Kind; includeSuperseded?: boolean }): Promise<MemorySummary[]>;
  findRelated(opts: {
    query?: string; tags?: string[]; limit?: number; bodyPreviewChars?: number;
  }): Promise<ScoredSummary[]>;

  rebuildIndex(): Promise<void>;        // delegates to index-renderer, then writeAtomic(active_memory.md)
  getMemoryBlock(): Promise<string>;    // reads active_memory.md + "## MEMORY" header
}
```

Faithful details from #360:
- `write` rejects an existing id (`FileExistsError`), validates `kind` against the allowed set.
- `update` never lets callers rename via patch (`id` is re-imposed).
- `list` excludes `superseded_by != null` by default.
- `findRelated`: haystack = `id + tags + kind + summary + body`; score = number of needles
  present; descending sort; bounded `limit`.

### 6.4 `core/session-log.ts`

```ts
export class SessionLog {
  constructor(private storage: StorageAdapter) {}
  startSession(): void;                 // reserve a pending/ path, lazy header
  logTurn(role: "user" | "assistant", content: string): Promise<void>;
  logToolCall(name: string, args: object, result: object): Promise<void>;
  readCurrent(): Promise<string>;       // for short_term_memory
  currentPath(): string | null;         // invariant: the dreamer never touches this file
}
```

### 6.5 `core/index-renderer.ts`

Port of `index_renderer.py` + spec §4. Generates `active_memory.md`:

```markdown
# Memory index
## Core (pinned)
- [id] summary
## Recent (last 30 days)
### Chess
- [id] summary
## Older
Tags (count), ranked by frequency:
- work (8), family (5), ...
Use recall_topic(tag) to load.
```

Grouped by `tags[0]`. The Older section ranks tags by count (truncate to top-15 beyond ~20 tags).

### 6.6 `core/dreamer.ts` (the heart)

```ts
export class Dreamer {
  constructor(
    private store: MemoryStore,
    private log: SessionLog,
    private storage: StorageAdapter,
    private llm: LLMClient,
    private opts: { model?: string; onProgress?: (s: DreamStat) => void },
  ) {}

  /** Process every pending log except the current session. */
  async dream(): Promise<DreamReport>;
}
```

Algorithm (port of spec §7):

```
for log in sorted(pending) where log != current:
    context = index + memory summaries + log contents
    result  = llm.complete(system=DREAMER_PROMPT, messages=[context], tools=DREAMER_TOOLS)
              // internal tool-calling loop until the LLM returns with no tool call
    apply(result)                 // write/update via store
    store.markLogProcessed(log)   // move pending -> processed
    stats.push(perLogStat)
store.rebuildIndex()
// (optional v1.1) selfReflection(stats) -> console log
```

Tools exposed **to the dreamer only** (never to the conversation LLM):

```ts
const DREAMER_TOOLS: ToolSpec[] = [
  read_log, list_existing_memories, read_memory,
  write_memory, update_memory, rebuild_index, mark_log_processed,
];
```

The dreamer system prompt embeds the **5 rules** (atomicity, overlap-first, evidence,
conflict, pin) — copied near-verbatim from spec §6 (described upstream as "the highest
leverage in the whole system"; we do not rewrite it).

### 6.7 `core/recall.ts`

The three live tools (spec §5.1), wired into the app's tool-call handler:

```ts
export function makeRecallTools(store: MemoryStore, log: SessionLog) {
  return {
    specs: [recallMemorySpec, recallTopicSpec, shortTermMemorySpec],
    handle(call: ToolCall): Promise<{ ok: boolean; message: string }>,
  };
}
```

- `recall_memory(id)` -> the memory plus all memories in `related_to`.
- `recall_topic(tag, limit=5)` -> memories matching the tag, bounded.
- `short_term_memory()` -> the current session log, raw.

### 6.8 `index.ts` (facade)

```ts
export function createMemory(deps: {
  storage: StorageAdapter;
  llm: LLMClient;
  config?: { dreamerModel?: string; enabled?: boolean };
}): {
  // live
  startSession(): void;
  logTurn(role: "user" | "assistant", content: string): Promise<void>;
  logToolCall(name: string, args: object, result: object): Promise<void>;
  getMemoryBlock(): string;     // synchronous: returns the cached block (see §8)
  recallTools: { specs: ToolSpec[]; handle(call: ToolCall): Promise<{ ok: boolean; message: string }> };
  // inter-session
  dream(): Promise<DreamReport>;
};
```

---

## 7. Adapters (stay in the app)

### 7.1 `storage-tauri-fs.ts`
Implements `StorageAdapter` via `@tauri-apps/plugin-fs`. `writeAtomic` = write temp + `rename`.
Root: `appDataDir()/memory/`. **Phase 0 check**: confirm the FS plugin is present in
`src-tauri/capabilities/default.json` (add it otherwise).

### 7.2 `storage-localstorage.ts`
Web / dev fallback. Emulates a flat FS with a key prefix (`mem:/memories/...`).
`append` = read + concat + write. Sufficient for dev and small volumes.

### 7.3 `llm-hf-router.ts`
Implements `LLMClient` against `router.huggingface.co/v1/responses` with the user's HF token —
the same pattern as `features/conversation/vision/providers/hf-vlm-provider.ts`. Text +
tool-calling model, configurable via `dreamerModel`.

---

## 8. Mobile-app integration (exact sites)

| # | File | Change |
|---|------|--------|
| 1 | `engine/memory/` (new) | the whole module above |
| 2 | `bridge/openai-bridge.ts` (`next.on("transcript")`, ~L287) | add `memory.logTurn(role, text)` on **final** transcripts of both roles (today only the final user transcript is used, for vision) |
| 3 | `tools/tool-call-handler.ts` | log tool calls (`memory.logToolCall`); replace the `remember` / `forget` dispatch with `recall_memory` / `recall_topic` / `short_term_memory` (delegate to `recallTools.handle`) |
| 4 | `engine/tools.ts` | drop `remember` / `forget` from `ROBOT_TOOLS`, add the three recall specs (imported from the module) |
| 5 | `conversation-engine.ts` `composeInstructions()` (~L1165) | `memoryStore.formatForPrompt()` -> `memory.getMemoryBlock()`; the tool filter (~L1187) lists the recall tools instead of remember/forget |
| 6 | `conversation-engine.ts` `boot()` / `doStart()` | trigger `memory.dream()` in the **background** (non-blocking) over previous sessions; call `memory.startSession()` at the start of a conversation |
| 7 | Memory dialog UI (the component consuming `useMemoryStore`) | render structured memories (grouped by tag, kind/pinned badges) instead of the flat list |

**Async note**: `composeInstructions` is synchronous today. We keep it that way by
**pre-loading the block** into RAM: when `dream()` finishes (and on `startSession`), we
`rebuildIndex()` and cache the rendered block; `getMemoryBlock()` returns the cache
synchronously. No I/O in the reconnect hot path.

---

## 9. Migration from the current `memory.ts`

One-shot on first boot of the new system:
- Read `localStorage["reachyMini.memory.v1"]` (the `MemoryFact[]`).
- Write them into a `pending/migrated_<date>.log` (one line per fact) — the dreamer turns
  them into atomic memories on the next dream pass.
- Keep the old key read-only for a while (rollback), then delete it.

Simpler alternative: convert each fact to a `kind: other`, `tags: []` memory. Less clean
(no consolidation) but immediate. **To decide with Rémi.**

---

## 10. Config & toggles

- `isMemoryEnabled()` (already exists) gates everything: no logging, no injection, no recall
  tools, no dreaming.
- `dreamerModel`: env / config, defaults to a reasonable text model on the HF router.
- Dreaming mode: `background` (mobile default) vs `blocking` (option). **To align with Rémi.**

---

## 11. Testing strategy (Vitest, already set up)

- **core/ without a browser**: `InMemoryStorage` (Map) + `FakeLLM` (scripted tool-call scenarios).
- Port the #360 tests: `test_frontmatter`, `test_memory_manager`, `test_dreamer` (adapted to TS).
- `dreamer`: feed a scripted log -> assert on created/superseded files + index rebuild.
- Adapters: light tests (localStorage under jsdom; tauri-fs mocked).
- Edge cases: empty log, huge fact, colliding ids, corrupted frontmatter, supersede chains.

---

## 12. Phasing & acceptance criteria

| Phase | Deliverable | Done when |
|-------|-------------|-----------|
| 0 | ports + `InMemoryStorage` + `FakeLLM` + `frontmatter` + tests | `yarn test` green, frontmatter round-trip OK |
| 1 | `session-log` + transcript wiring (bridge) | a pending log fills up in a real conversation |
| 2 | `memory-store` + `index-renderer` + ported tests | CRUD + rendered index correct on fixtures |
| 3 | `dreamer` + `llm-hf-router` adapter | a scripted log produces the right memories |
| 4 | recall tools + injection (replaces remember/forget) | the conversation reads the index + can recall live |
| 5 | `tauri-fs` adapter + migration | real on-device persistence + old memory carried over |
| 6 | structured dialog UI | the user can see/edit memories grouped by tag |

Order: from highest-risk (design validation in 0-1) to most visible (UI in 6).

---

## 13. Open questions to settle with Rémi

1. **Background vs blocking dreaming** on mobile.
2. **Identical Python/JS format** for interop (recommendation: yes, strongly).
3. **Migration**: via a log to dream (clean) vs direct conversion (fast).
4. **Package name / scope** and which API surface to freeze now.
5. **Self-reflection pass** (spec §7.2): ship in v1 or v1.1?

---

## References

- `reachy_mini_conversation_app` PR #360 — `docs/memory-system-design.md`,
  `docs/memory-rework-dreaming-spec.md`.
- [Letta Filesystem benchmark](https://www.letta.com/blog/benchmarking-ai-agent-memory) — flat files beat vector DBs.
- [Letta sleep-time compute](https://www.letta.com/blog/sleep-time-compute) — the dreaming precedent.
