# Daemon log streaming over WebRTC (v1)

## Status

**Landed.** The mobile app reads `journalctl -u reachy-mini-daemon`
through a WebRTC DataChannel command, courtesy of the SDK's
`subscribeLogs` API on branch `feat/subscribe-logs-cmd` of
`pollen-robotics/reachy_mini`. The console lives in the Robot tab
under the "Logs" section.

## What shipped vs what was planned

The original plan ([archived below](#archived-original-pr-plan-for-reference))
called for a richer wire schema with batching, back-pressure
signalling and severity inference on the daemon side. The branch
that actually landed (`feat/subscribe-logs-cmd`, commit
`c56a2bcd feat/webrtc logs`) is a **simpler v1**:

| Field                  | Plan                                              | Landed v1                 |
| ---------------------- | ------------------------------------------------- | ------------------------- |
| Subscribe command type | `subscribe_logs`, `tail_lines: int`               | `subscribe_logs` (no opts) |
| Server message type    | `log_lines` (batched array)                       | `log_line` (one per line) |
| Severity on the wire   | `LogLine.level: debug/info/warning/error`         | -                         |
| Back-pressure          | `LogStreamDroppedMsg` with cumulative drop count  | -                         |
| Filtering              | -                                                 | -                         |

We classify and infer severity client-side (see
`src/features/daemon-logs/parse.ts`) so the daemon side stays a
thin pipe.

## Wire protocol (actual v1)

`reachy_mini.io.protocol`:

```python
class SubscribeLogsCmd(BaseModel):
    type: Literal["subscribe_logs"] = "subscribe_logs"

class UnsubscribeLogsCmd(BaseModel):
    type: Literal["unsubscribe_logs"] = "unsubscribe_logs"

class LogLineMsg(BaseModel):
    type: Literal["log_line"] = "log_line"
    timestamp: str  # ISO short-iso UTC, e.g. "2026-05-10T11:35:35.123Z"
    line: str       # raw Python-formatted log line

class LogStreamErrorMsg(BaseModel):
    type: Literal["log_stream_error"] = "log_stream_error"
    error: str
```

## SDK API (`reachy-mini.js`)

```ts
const unsubscribe = robot.subscribeLogs({
  onLine: ({ timestamp, line }) => { /* … */ },
  onError: (error) => { /* … */ },
});
// later
unsubscribe();
```

The SDK keeps a single shared subprocess on the daemon side: the
first local `subscribeLogs` sends `subscribe_logs`, removing the
last subscriber sends `unsubscribe_logs`. Calling `unsubscribe()`
twice is a no-op. The SDK also clears its subscriber set on
`stopSession()` / `disconnect()`, so consumers must re-subscribe
after a release / re-acquire cycle (which is exactly what the
mobile app's `useDaemonLogs` hook does, gated on `isLive`).

## Mobile app integration

| Layer    | File                                                                       | Role                                                                         |
| -------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| SDK      | `src/vendor/reachy-mini.js`                                                | `subscribeLogs(...)` (vendored from upstream).                               |
| Types    | `src/vendor/reachy-mini.d.ts`, `src/features/robot-session/sdk-types.ts`   | Surface the SDK method to TS.                                                |
| Engine   | `src/features/conversation/engine/conversation-engine.ts`                  | Pass-through with noop fallback for older daemons.                           |
| Session  | `src/features/robot-session/useRobotSession.ts`                            | `RobotSessionHandle.subscribeLogs` exposed to UI.                            |
| Module   | `src/features/daemon-logs/`                                                | `useDaemonLogs` hook, ring buffer (100 lines), level/category inference.     |
| Widget   | `src/ui/widgets/daemon-logs/DaemonLogConsole.tsx`                          | Live tail, status pill, copy / clear, autoscroll-when-pinned-to-bottom.      |
| Surface  | `src/ui/panels/robot/RobotTabView.tsx`                                     | "Logs" section in the Robot tab.                                             |

The widget subscribes whenever the host passes `enabled: true`
(currently driven by `session.hasReachedReady`), so the buffer
keeps filling across tab switches and only resets on
`isLive: false`.

### Minimal v1 UX scope

- **No filters / no search**: a phone screen is too narrow to host
  the desktop's filter chip row. Devs who need to grep something
  can `Copy all` and paste into a text editor.
- **No Simple/Dev toggle**: the mobile console always renders the
  "Dev" layout (badge + colored message + clock).
- **No virtualisation**: 100-line cap fits comfortably in a flat
  `map()` render. We can swap in `@tanstack/react-virtual` if the
  cap ever grows past ~1000.

### Known limitations

- The mobile app sees the same lines a remote `journalctl -f`
  would see. Anything written to the daemon's stdout/stderr that
  isn't captured by `journald` (e.g. third-party app processes
  routed elsewhere) is invisible. This matches the desktop's
  `/logs/ws/daemon` WebSocket behaviour.
- The `timestamp` field on the wire is journalctl's UTC ISO
  string. We display the local `Date.now()` clock time on each
  row instead, so the right-hand column matches what a user sees
  on their own phone wall clock; the daemon timestamp is kept on
  the entry for forensic purposes (`rawTimestamp`) but not
  rendered.
- `journalctl` is unavailable on macOS dev hosts. The daemon
  surfaces a `log_stream_error` and the console renders an
  `ERROR` pill with the message, instead of silently freezing.

---

## Archived original PR plan (for reference)

> Kept verbatim for context on what was deferred (back-pressure,
> level on the wire, batching). If a future iteration needs any of
> these, this is the starting design.

### PR plan: `feat(webrtc): subscribe_logs DataChannel command for daemon journalctl streaming`

#### Context

Today, the daemon exposes journalctl logs via a WebSocket route at
`/logs/ws/daemon` (see
`reachy_mini/src/reachy_mini/daemon/app/routers/logs.py`). The
desktop app reaches it directly over LAN (`useDaemonLogStream`
checks `connectionMode === 'wifi'` + `remoteHost`). The mobile
app, which connects to the robot through Central + WebRTC, has
**no path** to the daemon's HTTP server, so logs are unreachable.

A previous attempt (PR #1068 `feat/webrtc-http-proxy`) added a
generic `HttpProxyCmd` that would have routed REST calls over the
DataChannel. It was merged and immediately reverted (commit
`047492de`). Even unreverted, it would not have covered
`/logs/ws/daemon` since that route is a WebSocket, not REST.

This PR takes the typed-Cmd path, aligned with the philosophy made
explicit by the revert ("typed `*Cmd` schemas should be
preferred").

#### Repository / branching

- Repo: `pollen-robotics/reachy_mini`
- Base branch: `mobile-app-integration-light`
- Feature branch: `feat/subscribe-logs-cmd` (dérivée de
  `mobile-app-integration-light`)
- Author: `tfrere`

#### Scope

##### In scope (v1, planned)

- Two new client -> server commands: `subscribe_logs`,
  `unsubscribe_logs`
- Three new server -> client message types: `log_lines` (batched),
  `log_stream_error`, `log_stream_dropped`
- One DataChannel handler in `daemon/backend/abstract.py`,
  factored on top of a shared journalctl helper used by both this
  handler and the existing `routers/logs.py` WebSocket
- SDK JS API: `subscribeLogs({ tailLines, onLines, onError,
  onDropped })` returning an `unsubscribe()` function
- TypeScript declarations updated in `reachy-mini.d.ts` (vendored
  copy must be kept in sync in the mobile app)
- Tests covering subscribe/unsubscribe lifecycle, peer-disconnect
  cleanup, journalctl-missing fallback, idempotency

##### Out of scope

- No mobile UI integration in this PR (separate follow-up PR on
  `reachy_mini_mobile_app`)
- No filter / regex / level options on the daemon side: the
  client classifies and filters
- No multi-unit support (`unit` is hard-coded to
  `reachy-mini-daemon` for v1)
- No `since_timestamp` / catch-up windows
- No automatic re-subscribe across release/reacquire cycles in
  the SDK (the consumer drives this)
- No global stream quota across multiple peers (YAGNI tant qu'on
  n'a qu'un mobile par robot)
- No stderr ringbuffer fallback when journalctl is missing
  (return `log_stream_error` and stop)

> **Note (post-merge):** the v1 that landed dropped batching,
> back-pressure signalling and `tail_lines`. See the table at the
> top of this doc for the actual surface.

#### Trust boundary note

The PR description should explicitly state:

> This extends the trust granted by the existing WebRTC peer auth
> (HF Central producer in remote, GStreamer signaling on LAN) to
> verbatim daemon stderr. Anything that ends up in `journalctl -u
> reachy-mini-daemon` becomes readable by any authenticated peer.
> This matches what the existing `/logs/ws/daemon` WebSocket
> already exposes on LAN; we are widening the access path, not
> the surface area. The `unit` parameter is hard-coded to prevent
> this from becoming a generic system-introspection primitive.

#### Out-of-scope follow-ups

- Mobile UI: a `Logs (dev)` section in `RobotTabView`, gated on a
  "developer mode" toggle in Settings, virtualized list, with
  markers for `log_stream_dropped` gaps. **Done for the basic
  case** (no developer-mode gate, no `dropped` markers since the
  daemon doesn't emit them yet).
- Optional `since_timestamp` parameter on subscribe to support
  gap-free re-subscribe across iframe handoff cycles.
- Optional batching tuneables (`batch_window_ms`,
  `batch_max_lines`) if the default 50 ms / 32 lines proves wrong
  on real hardware.
- Stderr ringbuffer fallback for non-systemd dev environments.
