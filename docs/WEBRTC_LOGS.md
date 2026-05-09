# PR plan: `feat(webrtc): subscribe_logs DataChannel command for daemon journalctl streaming`

## Context

Today, the daemon exposes journalctl logs via a WebSocket route at `/logs/ws/daemon` (see `reachy_mini/src/reachy_mini/daemon/app/routers/logs.py`). The desktop app reaches it directly over LAN (`useDaemonLogStream` checks `connectionMode === 'wifi'` + `remoteHost`). The mobile app, which connects to the robot through Central + WebRTC, has **no path** to the daemon's HTTP server, so logs are unreachable.

A previous attempt (PR #1068 `feat/webrtc-http-proxy`) added a generic `HttpProxyCmd` that would have routed REST calls over the DataChannel. It was merged and immediately reverted (commit `047492de`). Even unreverted, it would not have covered `/logs/ws/daemon` since that route is a WebSocket, not REST.

This PR takes the typed-Cmd path, aligned with the philosophy made explicit by the revert ("typed `*Cmd` schemas should be preferred").

## Repository / branching

- Repo: `pollen-robotics/reachy_mini`
- Base branch: `mobile-app-integration-light`
- Feature branch: `feat/subscribe-logs-cmd` (dérivée de `mobile-app-integration-light`)
- Author: `tfrere`

## Scope

### In scope (v1)

- Two new client -> server commands: `subscribe_logs`, `unsubscribe_logs`
- Three new server -> client message types: `log_lines` (batched), `log_stream_error`, `log_stream_dropped`
- One DataChannel handler in `daemon/backend/abstract.py`, factored on top of a shared journalctl helper used by both this handler and the existing `routers/logs.py` WebSocket
- SDK JS API: `subscribeLogs({ tailLines, onLines, onError, onDropped })` returning an `unsubscribe()` function
- TypeScript declarations updated in `reachy-mini.d.ts` (vendored copy must be kept in sync in the mobile app)
- Tests covering subscribe/unsubscribe lifecycle, peer-disconnect cleanup, journalctl-missing fallback, idempotency

### Out of scope

- No mobile UI integration in this PR (separate follow-up PR on `reachy_mini_mobile_app`)
- No filter / regex / level options on the daemon side: the client classifies and filters
- No multi-unit support (`unit` is hard-coded to `reachy-mini-daemon` for v1)
- No `since_timestamp` / catch-up windows
- No automatic re-subscribe across release/reacquire cycles in the SDK (the consumer drives this)
- No global stream quota across multiple peers (YAGNI tant qu'on n'a qu'un mobile par robot)
- No stderr ringbuffer fallback when journalctl is missing (return `log_stream_error` and stop)

## Protocol additions

`src/reachy_mini/io/protocol.py`

```python
# ---------------------------------------------------------------- 
# Daemon log streaming (DataChannel-only).
# 
# Read-only stream of journalctl lines for the `reachy-mini-daemon`
# unit, push-based and batched to keep DataChannel head-of-line
# blocking under control. The unit is hard-coded: this is not a
# generic "tail any service" primitive, it is the same content that
# the existing /logs/ws/daemon WebSocket exposes, exposed over the
# typed transport so remote (Central-routed) peers can consume it.
# ---------------------------------------------------------------- 

class SubscribeLogsCmd(BaseModel):
    """Subscribe the calling peer to the daemon's journalctl stream.

    Idempotent: re-subscribing while a stream is already running on
    the same peer cancels the previous subprocess and restarts with
    the new `tail_lines` value. Auto-cleaned on peer disconnect.
    """

    type: Literal["subscribe_logs"] = "subscribe_logs"
    # Number of historical lines to replay before switching to live
    # follow. Clamped at the handler.
    tail_lines: int = Field(100, ge=0, le=1000)


class UnsubscribeLogsCmd(BaseModel):
    """Stop the calling peer's log subscription. No-op if no stream."""

    type: Literal["unsubscribe_logs"] = "unsubscribe_logs"


class LogLine(BaseModel):
    """Individual journalctl line within a `log_lines` batch."""

    # ISO timestamp from journalctl --output short-iso
    timestamp: str
    line: str
    # Best-effort severity. Inferred from the line content (matches
    # the desktop app's `parseDaemonLogLevel` heuristic), null when
    # we can't classify.
    level: Optional[
        Literal["debug", "info", "warning", "error", "critical"]
    ] = None


class LogLinesMsg(BaseModel):
    """Batched journalctl lines for the active subscriber.
    
    Batching window: lines are flushed when EITHER 50 ms have
    elapsed since the first buffered line OR 32 lines are queued,
    whichever comes first. This keeps DataChannel pressure bounded
    even when a noisy app spams the daemon log.
    """

    type: Literal["log_lines"] = "log_lines"
    lines: list[LogLine]


class LogStreamErrorMsg(BaseModel):
    """Subscription failed (e.g. journalctl missing on dev macOS)."""

    type: Literal["log_stream_error"] = "log_stream_error"
    error: str


class LogStreamDroppedMsg(BaseModel):
    """Lines were dropped because the DataChannel is back-pressured.
    
    The handler watches the channel's `bufferedAmount`; when it
    crosses 256 kB, lines accumulate in a ring instead of being
    sent. Once the channel drains, a single `LogStreamDroppedMsg`
    is emitted with the count, so the client can mark a gap in
    its render.
    """

    type: Literal["log_stream_dropped"] = "log_stream_dropped"
    dropped: int
```

Add to existing unions:

```python
AnyCommand = Annotated[
    ...existing types...
    | SubscribeLogsCmd
    | UnsubscribeLogsCmd,
    Field(discriminator="type"),
]

AnyServerMsg = Annotated[
    ...existing types...
    | LogLinesMsg
    | LogStreamErrorMsg
    | LogStreamDroppedMsg,
    Field(discriminator="type"),
]
```

## Daemon implementation

### Shared helper

New file `src/reachy_mini/daemon/app/log_streaming.py`:

```python
async def stream_journalctl_lines(
    unit: str,
    tail_lines: int,
) -> AsyncIterator[tuple[str, str]]:
    """Yield (timestamp, line) tuples from `journalctl -u {unit} -b -f -n {n} --output short-iso`.
    
    Raises FileNotFoundError if journalctl is unavailable.
    Terminates the subprocess on cancellation / generator close.
    """
```

Refactor `routers/logs.py` to consume this helper instead of spawning the subprocess inline. Net: same WS behavior, single source of truth for the journalctl flags.

### DataChannel handler

In `daemon/backend/abstract.py`, alongside the existing command branches:

```python
elif isinstance(cmd, SubscribeLogsCmd):
    # Idempotent: cancel any previous stream for this peer.
    await self._cancel_log_subscription(peer_id)
    self._start_log_subscription(peer_id, send_response, cmd.tail_lines)

elif isinstance(cmd, UnsubscribeLogsCmd):
    await self._cancel_log_subscription(peer_id)
```

`_start_log_subscription`:
- spawns an asyncio task that consumes `stream_journalctl_lines`
- buffers lines into a per-peer queue with a 50 ms / 32-line flush window
- before each `data_channel.send(...)`, checks `data_channel.bufferedAmount`:
  - if under 256 kB: send the batch as `LogLinesMsg`
  - if over: discard the batch, increment `dropped` counter, send a `LogStreamDroppedMsg` with the cumulative count once the channel drains under the threshold
- catches `FileNotFoundError` -> sends `LogStreamErrorMsg`, marks the subscription as terminated
- registers a per-peer cleanup hook so peer disconnect cancels the task and terminates the subprocess

`_cancel_log_subscription`:
- cancels the task, awaits its termination with a short timeout, kills if needed
- removes the peer's entry from the per-peer registry

### Lifecycle hooks

Wire `_cancel_log_subscription` into the existing peer-disconnect path (TBD: identify the actual hook in `daemon/backend/abstract.py` or wherever per-peer cleanup currently lives). Verify that `stop_recording`-style cleanups already pass through the same hook so we follow the established pattern.

## SDK JS

`js/reachy-mini.js` (and `reachy-mini.d.ts`):

```ts
interface SubscribeLogsOptions {
  tailLines?: number;            // default 100
  onLines: (lines: LogLine[]) => void;
  onError?: (error: string) => void;
  onDropped?: (count: number) => void;
}

interface LogLine {
  timestamp: string;
  line: string;
  level: 'debug' | 'info' | 'warning' | 'error' | 'critical' | null;
}

class ReachyMini {
  subscribeLogs(options: SubscribeLogsOptions): () => void;
}
```

The returned function sends an `unsubscribe_logs` command and detaches the dispatcher. Calling it twice is a no-op.

## Tests

`tests/protocol/test_subscribe_logs.py`:

- `test_subscribe_emits_log_lines_messages`: feed a fake journalctl that prints 3 known lines, assert one `log_lines` message arrives with the correct fields.
- `test_unsubscribe_terminates_subprocess`: subscribe, unsubscribe, assert `process.returncode is not None` within 200 ms.
- `test_re_subscribe_is_idempotent`: subscribe twice in a row, assert only one subprocess is alive at any given point.
- `test_peer_disconnect_cleanup`: subscribe, simulate peer disconnect, assert subprocess is terminated.
- `test_journalctl_missing_emits_log_stream_error`: monkeypatch `asyncio.create_subprocess_exec` to raise `FileNotFoundError`, assert `log_stream_error` is sent.
- `test_backpressure_drops_lines`: simulate `bufferedAmount` crossing 256 kB, assert lines are dropped and a single `log_stream_dropped` aggregate is sent on drain.

## Documentation updates

- `protocol.py` module docstring: add `subscribe_logs`, `unsubscribe_logs` to the client->server list and `log_lines`, `log_stream_error`, `log_stream_dropped` to the server->client list.
- README: brief mention of the new command in the WebRTC commands section.
- No CHANGELOG entry required (not exposed in any user-visible way until the mobile UI lands).

## Trust boundary note

The PR description should explicitly state:

> This extends the trust granted by the existing WebRTC peer auth (HF Central producer in remote, GStreamer signaling on LAN) to verbatim daemon stderr. Anything that ends up in `journalctl -u reachy-mini-daemon` becomes readable by any authenticated peer. This matches what the existing `/logs/ws/daemon` WebSocket already exposes on LAN; we are widening the access path, not the surface area. The `unit` parameter is hard-coded to prevent this from becoming a generic system-introspection primitive.

## Out-of-scope follow-ups

- Mobile UI: a `Logs (dev)` section in `RobotTabView`, gated on a "developer mode" toggle in Settings, virtualized list, with markers for `log_stream_dropped` gaps.
- Optional `since_timestamp` parameter on subscribe to support gap-free re-subscribe across iframe handoff cycles.
- Optional batching tuneables (`batch_window_ms`, `batch_max_lines`) if the default 50 ms / 32 lines proves wrong on real hardware.
- Stderr ringbuffer fallback for non-systemd dev environments.

## Validation plan

Before opening for review:

1. Run the new tests + the existing `tests/` suite green.
2. Run `mypy` and `ruff` clean on the touched files.
3. Smoke test on a real Reachy Mini:
   - `subscribeLogs` from a remote mobile app and verify lines arrive within 200 ms of the equivalent SSH `journalctl -f`.
   - Trigger a noisy app loop, verify backpressure drops are reported via `log_stream_dropped`.
   - Reboot the daemon mid-stream, verify the subscription self-terminates with `log_stream_error`.
   - Verify `joint_positions` / `head_pose` push rate is unaffected by the log stream (should remain ~50 Hz).
