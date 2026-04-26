# PR-D — OAuth refresh + daemon version probe

## Goal

Two related robustness fixes:

1. The HF token issued by `oauth-loopback` expires silently. Refresh
   it before expiry without bothering the user.
2. The mobile app may call daemon endpoints that don't exist on older
   daemon versions (e.g. `/api/hf-auth/refresh-relay`). Detect the
   mismatch at handshake and warn explicitly.

## Why

- Users coming back to the app after N days hit "Token rejected" and
  have to re-sign-in. Bad UX.
- Older daemons silently return 404 for newer endpoints, leading to
  cryptic failures (e.g. "Forget Wi-Fi" doing nothing).

## Scope

### OAuth refresh

- Introduce `useHfTokenRefresh()` hook
- Reads expiry hint from token payload (or schedules a refresh ~80%
  through token TTL)
- Calls HF refresh-token endpoint via `oauth-loopback` flow
- Falls back to forced sign-out if refresh fails (with a clear
  diagnostic event)

### Daemon version probe

- New `daemonProbeVersion(client)` reads `GET /api/version` (or
  `/api/daemon/info`, whichever the daemon exposes)
- Called early in `RobotSessionScreen` handshake
- Compares against `MIN_SUPPORTED_DAEMON_VERSION` constant
- Renders a non-blocking warning banner if older
  ("Some features may not work, please update your robot")

## Out of scope

- Auto-updating the robot's daemon (never)
- Hard-blocking on version mismatch (we warn, we don't gate)

## Test plan

- Mock token with 1-minute expiry, observe refresh fires before
  expiry, session keeps working
- Mock daemon version 0.0.0, observe warning banner
- Force refresh failure (mock 401), observe forced sign-out flow
