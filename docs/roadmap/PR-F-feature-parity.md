# PR-F — Feature parity via `RobotClient`

## Goal

Honor the architectural invariant: **all robot features go through
`RobotClient`**. Today AppsPanel and Forget Wi-Fi are local-only; this
PR lifts both to work over remote WebRTC + `http_proxy` as well.

## Why

The unification principle says feature code must not know its transport.
Two features still violate it:

- `AppsPanel` takes `daemonHost: string | null`
- `useBleSession.forgetWifi()` writes to a custom BLE characteristic

After this PR, both call `client.fetch(...)` and work identically in
local and remote sessions.

## Scope

### Mobile

- Migrate `AppsPanel` from `daemonHost` to `client: RobotClient`
- Internal `fetchHfToken` becomes `client.fetch('/api/hf-auth/token')`
- New `useForgetWifi(client)` hook calling
  `client.fetch('DELETE', '/api/wifi/connections')`
- Drop the BLE-only forget-wifi path; the new HTTP path works over BLE
  via the LAN HTTP transport too
- `RobotSessionScreen` menu shows "Forget Wi-Fi" + "Apps" entries in
  both local and remote modes

### Daemon (sibling PR upstream)

- New endpoint `DELETE /api/wifi/connections` (or `POST /wifi/forget`)
  delegating to the same `nmcli` logic as `bluetooth_service`
- Existing BLE handler can stay or become a thin wrapper around the
  new function (bonus refactor, optional)

## Out of scope

- Initial Wi-Fi provisioning (BLE-only by physical necessity, the
  robot has no IP yet)
- New apps in the catalog

## Dependencies

- Daemon PR `feat/wifi-forget-http-endpoint` must be merged before
  this PR's mobile half is unblocked.

## Test plan

- Local session: open Apps panel, launch an app, exit → no regression
- Remote session: open Apps panel, launch an app, exit → works
- Local session: Forget Wi-Fi → robot reverts to AP mode
- Remote session: Forget Wi-Fi → robot reverts to AP mode (and
  session disconnects, expected)
- Verify no `host:` or `daemonHost:` references in `src/conversation`
  or `src/components` after this PR
