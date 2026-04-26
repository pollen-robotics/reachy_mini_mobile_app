# Roadmap

This document tracks the planned evolutions of the mobile app, ordered by
dependency. Each entry maps to a single PR with a self-contained scope.

Architecture-wide invariants we commit to:

1. **`RobotClient` is the only contract.** Feature code never knows whether
   the underlying transport is local LAN HTTP or WebRTC + `http_proxy`.
2. **Discovery is unified.** Local (BLE) and remote (HF central) sources
   feed the same `RobotPresence` model.
3. **Connection UI is identical** for both transports. Only stepper labels
   differ.
4. **Logs stay in the code.** Structured, namespaced, redacted. They are
   not debug scaffolding to be removed; they are permanent observation
   points.

## PRs

| ID | Title | Scope doc | Status |
|----|-------|-----------|--------|
| PR-A | Structured logging (mobile) | [`PR-A-structured-logging.md`](./roadmap/PR-A-structured-logging.md) | draft |
| PR-B | Structured logging (daemon) | (lives in `pollen-robotics/reachy_mini`) | draft |
| PR-C | Presence model + typed diagnostics | [`PR-C-presence.md`](./roadmap/PR-C-presence.md) | draft |
| PR-D | OAuth refresh + version probe | [`PR-D-oauth-and-version.md`](./roadmap/PR-D-oauth-and-version.md) | draft |
| PR-E | Session manager + multi-transport | [`PR-E-session-manager.md`](./roadmap/PR-E-session-manager.md) | draft |
| PR-F | Feature parity via `RobotClient` | [`PR-F-feature-parity.md`](./roadmap/PR-F-feature-parity.md) | draft |

PRs are designed to be reviewable and mergeable independently. PR-F has a
sibling daemon PR (new HTTP endpoint for Wi-Fi forget) tracked upstream.

## Blind spots tracked in this roadmap

- Token expiry → PR-D
- Foreground resume / network change → PR-C
- WebRTC ICE failure observability → PR-E
- Daemon version mismatch → PR-D
- BLE permission denied → PR-C (diagnostics)
- Concurrent session eviction → PR-E (logging) + future UX polish

## Out of scope (forever, unless this list changes)

- Disk-persisted log files in production. Logs are console-only and
  permanent in the code.
- Sidecar daemon on the phone. The robot's daemon is the only daemon.
- Auto-updating the robot daemon from the app.
