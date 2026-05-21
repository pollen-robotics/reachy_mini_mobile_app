# MCP server for Reachy Mini, design proposal

> Status: design draft, May 2026.
> Companion docs: [`VISION.md`](./VISION.md), [`ROADMAP.md`](./ROADMAP.md),
> [`CONNECTION_FLOW.md`](./CONNECTION_FLOW.md), and the parent
> `reachy-mobile-2026-analysis.md` at the project-folder root.

## Why this doc exists

Today the mobile app is the only client that can drive a Reachy Mini's
tools (motion, memory, camera, logs). Every new tool requires:

1. A typed `Cmd` schema in `reachy_mini/io/protocol.py`
2. A handler in `daemon/backend/abstract.py`
3. An entry in the JS SDK's `js/reachy-mini-sdk.js`
4. A version bump of `@pollen-robotics/reachy-mini-sdk` in the mobile app
5. UI plumbing in `conversation/engine/tools/tool-call-handler.ts`

That pipeline is fine for one tightly-coupled mobile client, but it
prevents the rest of the agentic ecosystem from talking to a Reachy.
In May 2026 every serious agent runtime (Claude Desktop, Cursor, OpenAI
Agents SDK, LangGraph, Zed, Continue, Cody) speaks **MCP** as a client.
Wrapping the daemon in an MCP server unlocks that ecosystem with no
mobile-side change required.

This doc covers:

- Where the MCP server lives (in the daemon, not in central, not in the
  mobile)
- How clients reach it (LAN direct, HF central tunnel, on-robot stdio,
  mobile DataChannel)
- What it exposes (tools, resources, prompts)
- Auth + ACL
- Phasing
- What the mobile app changes look like once MCP is in place

## 1. Where the server lives

```
                  ┌────────── HF Central (HF Space) ──────────┐
                  │  signaling SSE + POST                      │
                  │  + thin MCP tunnel /mcp/{robot_id}        │
                  │  (just relays JSON-RPC, no MCP logic)     │
                  └─────────────────┬──────────────────────────┘
                                    │
                                    │ tunneled JSON-RPC
                                    ▼
┌────────────── Reachy on-robot daemon (Python, Raspberry Pi) ─────────────┐
│  reachy_mini/src/reachy_mini/daemon/app/main.py                          │
│  ├── router /api/...           (existing REST surface)                   │
│  ├── router /events            (existing GStreamer signaling WS)         │
│  ├── router /logs/ws/daemon    (existing journalctl WS)                  │
│  └── router /mcp               (NEW: FastMCP ASGI app)                   │
│                                                                          │
│      ┌─ FastMCP instance ───────────────────────────────────────┐       │
│      │   Tools, Resources, Prompts                              │       │
│      │   imports motion_bus, camera, memory, state_store        │       │
│      └──────────────────────────────────────────────────────────┘       │
│              ▲                  ▲                  ▲                     │
│  /mcp HTTP   │   /mcp over WebRTC DC               │  Unix socket stdio  │
│  (LAN)       │   (mobile, hot path)                │  (on-robot scripts) │
└──────────────┴─────────────────────────────────────┴─────────────────────┘
```

Three transports, **one backend**: the same `FastMCP` instance is mounted
behind the HTTP router, the WebRTC `DataChannel` dispatcher, and a Unix
socket stdio entrypoint.

### Why in the daemon, not elsewhere

The daemon is the only place that has:

- Direct bus access to Dynamixel motors (no network hop)
- The GStreamer pipeline for camera + audio
- The `state_store` snapshot in real time
- The `RobotAppLock` that already serialises competing apps
- A validated HF token from the existing signaling flow

Putting the MCP server in a sidecar process or in HF Central would mean
recreating an internal API just to drive the daemon, doubling the code
path with zero benefit. Keep it co-located.

### Why HF Central stays "dumb"

Central does **not** run any MCP logic. It only:

1. Validates the HF token (already does this for `/events`)
2. Verifies the user can access the requested robot (already does this)
3. Forwards JSON-RPC frames to the robot's signaling SSE channel

The actual tool execution happens on the robot. If Central goes down,
LAN clients keep working unchanged.

## 2. How to connect, depending on where the client is

The Reachy lives behind the user's home NAT, on a Raspberry Pi reachable
only at `192.168.x.y:8000` from the local Wi-Fi. Three reachability
patterns cover every realistic case.

### 2.1 LAN: same Wi-Fi as the robot

```
client ──► reachy-mini.local:8000/mcp
           (mDNS discovery, HTTPS direct, ~10 ms latency)
```

- mDNS resolves `reachy-mini.local` to the local IP
- TLS via the daemon's existing self-signed cert (or via a Tauri-level
  pinned cert for the mobile)
- Direct HTTP `Streamable MCP`, identical to any standard MCP server

This is the path the mobile already uses for `daemon_fetch`. Same
firewall posture, same auth.

### 2.2 Remote, no install: any MCP-aware client

```
client ──► https://pollen-robotics-reachy-mini-central.hf.space/mcp/{robot_id}
           Authorization: Bearer hf_xxx
           (HF central tunnels JSON-RPC frames to the daemon's SSE)
```

Latency around 80-200 ms per round-trip, fine for tool calls. **Not** for
the audio path (that stays on its own WebRTC track). Streaming tools
(`subscribe_state`, `subscribe_camera`) use Streamable HTTP's SSE side
to push notifications.

The user copies the URL + a robot-scoped token from the mobile app's
Settings tab into their MCP client config:

```json
{
  "mcpServers": {
    "reachy-mini": {
      "url": "https://pollen-robotics-reachy-mini-central.hf.space/mcp/abc123",
      "headers": {
        "Authorization": "Bearer hf_xxx"
      }
    }
  }
}
```

No daemon binary to install on the laptop, no port forwarding, no VPN.

### 2.3 Mobile app: WebRTC DataChannel, MCP framing

The mobile already has an `RTCPeerConnection` open with the daemon
(today's PC#1 carrying motion commands). On top of the existing
`oai-events`-style data channel for motion, add a second channel
`mcp` carrying JSON-RPC framing.

Benefits:

- ICE picks the LAN host candidate when the phone and robot are on the
  same Wi-Fi: ~5 ms latency, zero Internet dependency
- Falls back to TURN/relay automatically (same path as the audio)
- No second authentication: the WebRTC peer is already authenticated
- Backpressure piggy-backs on the existing `bufferedAmount` checks in
  `pose-dispatcher.ts`

The mobile becomes an MCP client of itself + the daemon, instead of
embedding tool logic in `conversation/engine/tools/tool-call-handler.ts`.

### 2.4 On-robot scripts (developers, on-device agents)

```
ssh pollen@reachy-mini.local
mcp-cli connect /run/reachy/mcp.sock
```

Unix socket exposes the same `FastMCP` instance over stdio. No network,
no auth (trust the local user). Used for development, for on-robot
edge-LLM clients, and for any future "the robot runs its own agent"
mode.

### 2.5 Failure modes

| Failure                       | LAN client | Remote client (Central) | Mobile (DC)              |
|-------------------------------|------------|-------------------------|--------------------------|
| HF Central down               | Works      | Down                    | Works (LAN candidate)    |
| Internet down at home         | Works      | Down                    | Works                    |
| Daemon restarted              | Reconnect  | Reconnect               | Reconnect (existing path)|
| Wi-Fi off                     | Down       | Works                   | Works (4G + Central)     |

Robot autonomy is the headline: an off-grid Reachy keeps responding to
LAN MCP clients. That matters for kiosks, demos, edge deployments.

## 3. Server capabilities

### 3.1 Tools (verbs the LLM can invoke)

| Tool                | Description                                                      |
|---------------------|------------------------------------------------------------------|
| `move_head`         | Named pose (up/down/left/right/tilt_*/center). Same as today.    |
| `set_head_rpy`      | Direct roll/pitch/yaw in degrees, for precise agents.            |
| `set_antennas`      | Right/left antennas in degrees.                                  |
| `play_move`         | Trigger a catalog choreography. Catalog auto-injected.           |
| `record_move`       | Start kinesthetic recording (gravity_compensation + capture).    |
| `wake_up`           | Play wake-up trajectory, enable motors.                          |
| `goto_sleep`        | Play sleep trajectory, disable motors.                           |
| `set_motor_mode`    | enabled / disabled / gravity_compensation.                       |
| `play_sound`        | One of the bundled wav files.                                    |
| `remember`          | Save a fact (with optional `actor` to namespace per-user).       |
| `forget`            | Free-text query removal; returns near-matches.                   |
| `take_photo`        | One JPEG frame from the camera, returned as image content.       |
| `start_recording`   | Begin an audio+video clip, returns a `clip_id`.                  |
| `stop_recording`    | Stop, returns a clip resource URI.                               |

#### Streaming tools (server emits intermediate `notifications/progress`)

| Tool                | Description                                                                   |
|---------------------|-------------------------------------------------------------------------------|
| `subscribe_state`   | Stream `state` events at N Hz (head pose, antennas, motor_mode).             |
| `subscribe_logs`    | Stream journalctl lines (subsumes the existing `subscribe-logs-pr-plan.md`). |
| `subscribe_camera`  | Stream JPEG frames at N Hz (rate-limited by `bufferedAmount`).               |
| `subscribe_audio`   | Stream Opus chunks of the robot mic (for transcription agents).              |

### 3.2 Resources (read-only, addressable, cacheable)

URIs use a `reachy://` scheme.

| URI                                  | MIME                | Notes                                          |
|--------------------------------------|---------------------|------------------------------------------------|
| `reachy://robot/info`                | `application/json`  | hardware_id, version, capabilities, install_id |
| `reachy://robot/state`               | `application/json`  | Latest `state` snapshot                        |
| `reachy://robot/health`              | `application/json`  | Motor errors, daemon uptime, temperatures      |
| `reachy://memory/facts`              | `application/json`  | All stored facts                               |
| `reachy://memory/facts/{id}`         | `application/json`  | One fact                                       |
| `reachy://camera/latest`             | `image/jpeg`        | Last keyframe, 4:3                             |
| `reachy://logs/recent?lines=N`       | `text/plain`        | Tail of journalctl                             |
| `reachy://moves/catalog`             | `application/json`  | Move ids + descriptions                        |
| `reachy://moves/{id}`                | `application/json`  | Trajectory keyframes                           |
| `reachy://recordings/{clip_id}`      | `video/webm`        | Output of `start/stop_recording`               |

Resources support `notifications/resources/updated` so an agent can
subscribe and get push updates instead of polling.

### 3.3 Prompts (parameterised templates)

| Prompt                | Args                            | Notes                                          |
|-----------------------|---------------------------------|------------------------------------------------|
| `companion`           | `language`, `tone`              | Today's `DEFAULT_INSTRUCTIONS`, parameterised. |
| `bedtime_stories`     | `theme`, `child_name`           | Persona bundle.                                |
| `presenter`           | `event`, `language`             | Demo / kiosk mode.                             |
| `coach`               | `discipline`                    | Sports coach Reachy.                           |
| `describe_scene`      | -                               | "Look at the camera and describe what you see"  |
| `morning_briefing`    | `calendar_url`, `weather_zip`   | Composes calls to other MCP servers.           |

## 4. Authentication and ACL

### 4.1 Identity

Reuse the existing HF OAuth path. No new identity provider.

- **LAN HTTP**: `Authorization: Bearer <HF_token>`. Daemon validates against
  HF's `/api/whoami` once per session, caches user identity for the
  connection lifetime.
- **Central HTTP**: Central is already authenticated. It forwards a signed
  `X-User-Id` internal header to the daemon.
- **WebRTC DataChannel**: WebRTC peer authentication (DTLS fingerprint +
  signaling token) carries through; no per-frame auth needed.
- **Unix socket stdio**: trust the local user (root/pollen on the robot).

### 4.2 Per-tool ACL

Configurable in `/etc/reachy/mcp-acl.toml`:

```toml
[default]
# Public tools always allowed.
allow = ["take_photo", "subscribe_state", "remember"]
# Motion needs an explicit grant.
deny = ["set_motor_mode", "wake_up", "goto_sleep"]

[user:tfrere]
# Owner can do anything.
allow = ["*"]

[user:guest]
# Read-only friends.
allow = ["take_photo", "subscribe_state", "memory/*"]
deny = ["*"]
```

### 4.3 Robot-scoped tokens

The mobile app's Settings tab generates **robot-scoped MCP tokens** for
external clients (Claude Desktop, Cursor, etc.):

- Distinct from the user's general HF token
- Encodes the `robot_id` it can talk to + the ACL group + an expiration
- Can be revoked from the mobile UI

This is the canonical answer to "I want my friend to ask my Reachy a
question": generate a 1-hour `guest`-scope token, share the URL, the
friend pastes it in their MCP client, the token expires automatically.

## 5. Mobile app integration

### 5.1 Where today's tool plumbing collapses

| Today                                                | After MCP                                                         |
|------------------------------------------------------|-------------------------------------------------------------------|
| `tools/tool-call-handler.ts` switch-case per tool    | Thin "post JSON-RPC frame to MCP client, await response"          |
| `tools.ts` static `ROBOT_TOOLS` descriptors          | Auto-fetched from `tools/list` MCP capability                     |
| `memory.ts` localStorage on phone                    | MCP resource consumer; storage on the daemon                      |
| Hard-coded `HEAD_POSES` table                        | Stays as enum on the daemon side, exposed via tool schema enum    |
| `subscribe_logs` planned PR                          | Just one more MCP streaming tool                                  |

### 5.2 New mobile-side primitives

```
src/mcp/
├── client.ts              # MCP client (fetch-based + DC-based transports)
├── transport-dc.ts        # JSON-RPC framing on the existing DataChannel
├── transport-http.ts      # Streamable HTTP for non-WebRTC paths (rare)
├── tools-cache.ts         # Cache the daemon's tool list per session
└── settings-bridge.ts     # Mint / revoke robot-scoped tokens for desktop
```

### 5.3 What stays unchanged

The audio path keeps its own WebRTC pipeline. MCP is for tools,
resources, prompts, low-frequency streams. Real-time audio (voice
in / TTS out) is too latency-sensitive to fit JSON-RPC framing and
keeps using its dedicated transceivers.

## 6. Phasing

| Phase | Scope                                                                | Outcome                                                                               |
|-------|----------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| P0    | FastMCP wrap of `move_head`, `play_move`, `take_photo` over LAN HTTP | Connect Claude Desktop to the robot on Wi-Fi. Demo video.                              |
| P1    | Resources: `state`, `camera/latest`, `memory/*`, `moves/catalog`     | Read-only inspection from any MCP client.                                              |
| P2    | Streaming tools: `subscribe_state`, `subscribe_logs`, `subscribe_camera` | Live introspection. Subsumes the existing `subscribe-logs` PR.                     |
| P3    | Auth + ACL + remote transport via HF central                          | Multi-user remote access with per-user permissions.                                    |
| P4    | Mobile app routes its motion + memory through MCP                     | One protocol everywhere; `tool-call-handler` shrinks.                                  |
| P5    | Robot becomes MCP client (calendar, email, other Reachy)              | "Web of Reachy" + personal-context agents.                                             |
| P6    | Persona library on HF Hub via MCP `prompts/*` capability              | Public marketplace of Reachy personalities, no client update needed.                   |

P0 is roughly an afternoon: ~150 lines of Python in
`reachy_mini/daemon/app/mcp/server.py`, one `app.mount('/mcp', mcp_app)`
in `main.py`, and a Claude Desktop config snippet.

## 7. Risks and open questions

- **Latency for hot-path tools.** Motion commands today land on the
  daemon in under 5 ms via DataChannel. MCP over Streamable HTTP adds
  HTTP framing overhead. Mitigation: keep the DataChannel transport
  for the mobile, fall back to HTTP only for external clients.
- **Versioning.** The MCP spec evolves quickly. Pin to a version, ship
  `serverInfo.version`, degrade gracefully on older clients.
- **Concurrency.** N agents can connect simultaneously; motion tools
  must serialise on a per-robot lock. Reuse the existing `RobotAppLock`
  pattern from `central_signaling_relay.py`.
- **Tool approval UX.** Motion is destructive; some MCP clients
  auto-approve tools by default. The daemon should support an "approval
  required" flag per tool, surfaced as a notification on the mobile
  ("Claude wants to make Reachy dance, approve?"). The MCP spec
  supports this via `humanReviewRequired` annotations.
- **Discoverability.** HF Hub should list the user's robots with their
  MCP URLs. Probably one extra `/api/robots` endpoint on central, since
  it already has the data.

## 8. Summary

Putting an MCP server in the on-robot daemon, tunneled through the
existing HF central signaling for remote clients and exposed directly on
LAN, turns Reachy Mini from "a robot driven by one mobile app" into "a
robot driven by any agent that speaks MCP". The mobile app benefits
immediately (less bespoke tool plumbing, easier to extend), and the
ecosystem benefits (Claude Desktop, Cursor, OpenAI Agents SDK, custom
agents all gain Reachy as a target) without any per-client integration
work. The audio path stays on its own WebRTC track for latency reasons;
MCP handles everything else.
