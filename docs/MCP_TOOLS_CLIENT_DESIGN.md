# MCP tool client for the mobile app, design draft

> Status: design draft, July 2026. Not implemented.
> Companion doc: [`MCP_DESIGN.md`](./MCP_DESIGN.md) covers the *opposite*
> direction (the robot daemon as an MCP **server** for external agents).
> This doc makes the mobile conversation engine an MCP **client** of
> remote tool Spaces. The two share nothing but the protocol; notably,
> `src/mcp/` is reserved by `MCP_DESIGN.md` and this work must live in
> `src/features/mcp-tools/` instead.

## Goal

Let the realtime voice conversation call tools hosted on Hugging Face
Spaces (search, weather, time, community tools), discovered by the
model itself at runtime instead of being statically compiled into
`ROBOT_TOOLS`.

The serving side already exists:

- `GET {WEBSITE_API_URL}/api/mcp-tools` returns the curated catalog of
  Spaces tagged `reachy-mini-tool`, with the same fail-closed moderation
  as `/api/js-apps` (official list + blocklist + LLM verdicts). As of
  July 2026 the catalog holds 5 Spaces; only the 3 official
  `pollen-robotics` ones are visible, the 2 third-party ones are hidden
  pending moderation.
- Each Space serves streamable-HTTP MCP at
  `https://{subdomain}.hf.space/gradio_api/mcp/`.

## Chosen architecture: model-driven discovery through meta-tools

Two always-present meta-tools, plus an optional hot schema injection:

- `search_tools(query)`: searches a **local** index of the catalog
  (substring, then BM25 over names + descriptions) and returns the
  matching tools' names and full JSON Schemas. No network on the hot
  path; the index is cached.
- `call_tool(tool, arguments)`: generic proxy. Resolves `tool` to a
  (Space, remote tool name) pair and performs the MCP `tools/call`.
- After a successful `search_tools`, the engine additionally pushes a
  mid-session `session.update` that registers the discovered tools as
  first-class functions, so the model fills arguments against a
  validated schema on the follow-up call.

### Why the proxy is load-bearing, not a fallback

Measured on the 5 real catalog tools (July 2026): naive
`{space_alias}__{remote_name}` concatenation produces function names of
75, 78, 69, 97 and 49 characters against the API's 64-character limit.
Even after stripping the redundant Space-name prefix (the heuristic the
Python conversation app uses), `it-at-m/reachy-mini-munich-services-tool`
lands on **exactly 64**. One more character in any community Space name
breaks first-class registration.

With the proxy, the remote tool name travels in the *arguments*, never
in the function-name namespace, so the limit becomes irrelevant. The
degradation rule is therefore:

1. Hot-inject the discovered tool as a first-class function when its
   cleaned name fits within 64 characters (better argument filling).
2. Otherwise, the model keeps using `call_tool` with the schema returned
   by `search_tools` still fresh in context.

### Flow

```
session open ──► session.update: ROBOT_TOOLS + search_tools + call_tool
             └─► fire-and-forget HEAD prewarm on enabled Spaces

user: "what's the weather in Paris?"
model ──► search_tools("weather")
engine ──► local index lookup (no network)
       └─► HEAD prewarm on the matched Space(s)
engine ──► result: [{name, description, inputSchema}]
engine ──► session.update (hot): add the matched tool if name <= 64
model ──► calls the tool (first-class or via call_tool)
engine ──► JSON-RPC tools/call on the Space, 5 s abort budget
engine ──► function_call_output: flattened, size-capped result
```

## Verified constraints (all measured, not assumed)

### Realtime session

- `session.update` is currently sent **once**, in `handleOpen`
  (`src/features/conversation/engine/huggingface-realtime.ts`, ~l.253).
  There is no re-send path today.
- A generic escape hatch already exists and is the planned channel for
  the hot update: `RealtimePort.sendEvent`
  (`src/features/conversation/engine/realtime/types.ts` l.35-42),
  exposed via `getRealtimePort()` and exercised by the vision
  scene-injector (`vision/scene-injector.ts` l.45).
  **Do not remove `RealtimePort` when cleaning up passive vision**: the
  comment in `vision/index.ts` (l.24-26) floats reverting it "for
  cleanliness", which would strand this design.
- The `tools()` getter (`conversation-engine.ts` l.1061) is synchronous
  and resolved once per `buildClient()`; anything it returns must
  already be in a local cache.
- Tool results go back as `conversation.item.create` /
  `function_call_output` with a JSON string `output`, followed by
  `response.create` (`huggingface-realtime.ts` l.315-326). The result
  type `{ ok: boolean; message: string }` is pinned in three places
  (`tool-call-handler.ts` l.52, `realtime/types.ts` l.76, the bridge)
  and should be kept as-is; MCP content blocks get flattened and
  size-capped into `message`.
- The "processing hold" backstop is
  `TOOL_CALL_PROCESSING_FALLBACK_MS = 15_000`
  (`huggingface-realtime.ts` l.40). There is **no timeout at all** in
  `tool-call-handler.ts` today; a hanging remote Space would freeze the
  conversation with no error surfaced to the model.

### MCP transport (probed against the live Spaces)

- Endpoint per Space: `https://{subdomain}.hf.space/gradio_api/mcp/`.
- The request MUST send `Accept: application/json, text/event-stream`,
  otherwise the server answers 406.
- Responses arrive as `text/event-stream` frames (`data: {...}`) even
  for single-shot replies; the client must parse SSE framing.
- Warm `tools/list` round-trip: 0.4-1.1 s. Cold (sleeping Space):
  ~40 s observed on `danney99/rocky-voice-tts`, then 0.42 s once awake.
- `*.hf.space` is already allow-listed for `tauri-plugin-http` in
  `src-tauri/capabilities/default.json` (`http:default`), so
  `tauriFetch` works without capability changes.

### Catalog

- `/api/mcp-tools` returns **Spaces, not tools**. It never probes the
  MCP endpoint (`extra.tools` is empty on all 5 entries), so a listed
  Space can have a dead `/mcp` and the client must handle probe failure
  gracefully at index time.
- Each current Space exposes exactly 1 tool; total schema payload for
  all 5 is ~2.5 kB (~610 tokens). Context budget is a non-issue at this
  scale; the point of `search_tools` is precision and targeted
  prewarming, not token savings.
- The HF Spaces listing does not expose `runtime` (the field is absent
  even with `full=true`); knowing whether a Space is awake requires one
  `GET /api/spaces/{id}` per Space.

### Cold start policy

Free `cpu-basic` Spaces sleep after 48 h of inactivity (fixed, not
configurable on free hardware). Decisions from the July 2026
investigation:

- **No keep-alive pinging, and no Space-to-Space ping mesh.** A sleeping
  Space runs no code, so a mesh self-destroys after any platform-wide
  event, and HF's abuse-handler has already hard-paused a Space for
  exactly this pattern (forum report, May 2026, keepalive ping from a
  Cloudflare Worker). The legitimate fix for first-party tools is paid
  hardware / disabled sleep, which is an internal infra request, not
  app code.
- **Decouple "what the model sees" from "what is awake".** Search-first
  removes the natural prewarm moment, so the engine prewarms
  independently: fire-and-forget `HEAD` on every enabled Space at
  session open (0.6-1.0 s each, parallel, non-blocking), plus a targeted
  prewarm on every `search_tools` hit.
- **Never block the conversation.** MCP calls get a ~5 s
  `AbortController` budget; on timeout the model receives
  `{ ok: false, message: "tool is waking up, try again shortly" }` so it
  can speak instead of leaving dead air while the wake continues in the
  background.

## Implementation plan

### P0, blocking spike (0.5 day)

Two unknowns gate the hot-update half of the design:

1. Does the HF realtime backend accept a mid-session `session.update`
   that changes `tools`? Send it through
   `getRealtimePort().sendEvent(...)` on a live session and watch for
   `session.updated` (already handled as a no-op case) vs an `error`
   frame.
2. Does it accept a partial `session` object (only `tools`), or must the
   full config be rebuilt through `buildHfSessionConfig`
   (`huggingface-realtime.ts` l.554-603)?

If hot update is refused, the proxy-only design still ships; only the
argument-filling precision upgrade is lost.

### P1, MCP client + catalog index (1 day)

New directory `src/features/mcp-tools/`, mirroring `src/features/apps/`:

- `mcpClient.ts`: JSON-RPC over streamable HTTP via `tauriFetch`
  (dual `Accept` header, SSE frame parsing,
  `initialize` / `tools/list` / `tools/call`).
- `useMcpTools.ts`: TanStack Query on `/api/mcp-tools`, key
  `['mcp-tools-catalog']`, `staleTime` 5 min (mirror of `useApps.ts`).
- `types.ts`: `McpToolEntry` / `RawMcpTool` (mirror of `AppEntry` /
  `RawCatalogApp` in `features/apps/types.ts`).
- `toolsIndex.ts`: probes each Space's `tools/list` (the API does not),
  persists the index in `localStorage` using the module-level store +
  `useSyncExternalStore` pattern from `useHiddenAuthors.ts`, key
  `reachy.mcp.toolsIndex`. Probe failures mark the Space unavailable
  instead of throwing.

### P2, engine wiring (1 day)

- Widen `RealtimeBackendDeps.tools` from `typeof ROBOT_TOOLS` to
  `RealtimeTool[]` (`realtime/types.ts` l.61).
- Register `search_tools` and `call_tool` specs in the `tools()` getter
  (`conversation-engine.ts` l.1061), gated on a non-empty index,
  following the existing feature-flag filter pattern.
- Two new `case` branches in the `tool-call-handler.ts` switch
  (l.163-266): local index search; proxied `tools/call` with content
  block flattening and a size cap into `{ ok, message }`.
- `AbortController` with a ~5 s budget on every MCP call; revisit
  `TOOL_CALL_PROCESSING_FALLBACK_MS`.
- Hot injection after `search_tools` via `RealtimePort.sendEvent`,
  with the <= 64 characters name gate and proxy degradation.

### P3, cold start (0.5 day)

- Parallel non-blocking `HEAD` prewarm at session open on enabled
  Spaces; targeted prewarm on `search_tools` hits.
- Optional, API side: enrich `/api/mcp-tools` with `runtime.stage`
  (one `GET /api/spaces/{id}` per Space, amortized over the server's
  5 min cache TTL in `mcpTools.js`).

### P4, minimal UI surface (0.5-1 day)

Model-driven discovery needs no store UI, but App Store compliance
still requires visibility and a kill switch for third-party tools that
send data off-device:

- A Settings section listing catalog Spaces with an on/off toggle,
  officials enabled by default. Persistence `reachy.mcp.enabledIds`
  (same `useSyncExternalStore` pattern).
- Usage indicator: reuse the existing `showToolToast` path in the tool
  call handler.
- The API's fail-closed moderation remains the first gate; the toggle
  is the user-side second gate.

Total estimate: **3.5 to 4 days**.

## Risks

- P0 gates P2's hot-update half. Proxy-only is the guaranteed floor.
- The model fills `call_tool` arguments without API-side schema
  validation. Mitigated by `search_tools` returning full JSON Schemas
  immediately before the call.
- A cataloged Space can have a dead MCP endpoint (the API never probes).
  Index-time probing must fail soft.
- `RealtimePort` / `getRealtimePort()` must survive the passive-vision
  cleanup on `feat/first-wake-up-status`; this design is its next
  consumer.
- Tool descriptions from third-party Spaces enter the prompt untouched
  once hot-injected; the moderation gate is the only filter. Keep the
  size cap on descriptions too, not just results.
