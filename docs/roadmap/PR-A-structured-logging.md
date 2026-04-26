# PR-A — Structured logging (mobile)

## Goal

Add **permanent**, structured, namespaced log statements at strategic
observation points across the app. Logs stay in the code as part of the
architecture, not as temporary debug scaffolding.

## Why

Connection flows (BLE handshake, central poll, WebRTC negotiation,
motor lifecycle) cross many layers and fail in subtle ways. Without
permanent observability, every new bug requires re-instrumenting the
code from scratch. We want a future bug report to be diagnosable from
DevTools console alone, with optional cross-boundary correlation
against the daemon (PR-B).

## Scope

### New module `src/logger/`

- `index.ts` — `createLogger(ns)` returning `{ debug, info, warn, error, child }`
- `redact.ts` — `redactToken(t)` (`hf_AbCd…XyZw`), `redactObject(kv)` walking known sensitive keys
- `format.ts` — pretty console renderer (level color, ns dim, kv inline)
- Level controlled at runtime via `localStorage.setItem('log:level', 'debug')`
- Optional namespace filter via `localStorage.setItem('log:filter', 'central.*,session.*')`

### Trace-id propagation

- One trace-id per robot session (generated when `target` is set in `App.tsx`)
- Threaded via React Context to all hooks/components that emit logs
- Sent as `X-Trace-Id` header on every `daemonFetch` HTTP call
- (Daemon side reception lives in PR-B; this PR is fully standalone)

### Instrumentation points (≈ 25)

| Namespace | Events |
|---|---|
| `auth` | `signin.start/success/failure`, `signout`, `token.expired` |
| `central.poll` | `start`, `success {robot_count, latency_ms}`, `error {reason}`, `token_validated {username}` |
| `ble` | `scan.start/stop`, `discovered {name}`, `connect.start/success/failure`, `disconnect {reason}` |
| `daemon.http` | `request {method, path}` (DEBUG), `response {status, latency_ms}` (DEBUG) |
| `daemon.probe` | `healthy`, `unhealthy {reason}` |
| `session` | `phase.transition {from, to}`, `target {kind, id}` |
| `engine` | `state.transition {from, to}`, `error {message}` |
| `motion` | `wake.start/complete`, `sleep.start/complete`, `error` |
| `webrtc` | `connection_state {state}`, `ice.state`, `datachannel.open/close` |

Existing `console.warn` / `console.info` calls **stay** for now; the new
logger is added at the strategic points without a big-bang migration.

## Out of scope

- Disk-persisted log files (decided permanently against)
- iOS-specific log viewer
- Daemon-side logging (= PR-B)
- Migration of all existing `console.*` calls (opportunistic, future)

## Test plan

- `localStorage.setItem('log:level', 'debug')`, reload, observe debug
  lines in console
- Filter test: `log:filter` set to `central.*` only shows central poll
- Unit tests for `redactToken` and `redactObject`
- Smoke test: full session from sign-in to live conversation should
  produce ≤ 30 log lines at INFO level
