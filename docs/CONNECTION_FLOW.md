# Connection flow - end-to-end specification

This document is the single source of truth for what the mobile app
does, from the moment it boots until the user disconnects from a
robot. It covers the auth gate, the unified discovery view, the local
(Bluetooth) and remote (Hugging Face central) connection paths, the
transport-agnostic daemon API layer, motor wake/sleep, and the
graceful teardown path.

**Read it before touching any of:**

- `src/App.tsx`
- `src/screens/*` (`RemoteSignInScreen`, `ScanScreen`, `RobotSessionScreen`, `WifiSetupScreen`)
- `src/auth/*` (`oauthLoopback`, `useRemoteHfToken`, `useRemoteRobots`, `useHfAuth`)
- `src/ble/useBleSession.ts`
- `src/wifi/useWifiSetup.ts`
- `src/daemon/*` (`robotMotion`, `useDaemonStatus`, `trajectoryGate`)
- `src/robot-client/*`
- `src/conversation/ConversePanel.tsx`

---

> # ⚠️ THE GOLDEN RULE - read this before everything else
>
> **There is exactly ONE way for the app to talk to the daemon: through
> `RobotClient.fetch(...)`, which rides the WebRTC `http_proxy`
> DataChannel.**
>
> Read carefully: this is NOT "WebRTC instead of LAN". WebRTC IS our
> LAN path when LAN is available. ICE negotiates a `host` candidate
> pair when both peers are on the same subnet, which means the
> DataChannel runs as straight UDP P2P between the phone and the
> robot - no TURN relay, no cloud round-trip. Same `RobotClient.fetch`
> call, ICE just picked a faster route. That is exactly what we want
> and exactly what makes the second-transport temptation pointless.
>
> What is forbidden is a **second, parallel LAN path that is HTTP**:
>
> - No `daemonFetch(192.168.x.y:8000, ...)` shim, ever.
> - No "tiny direct fetch" to the daemon's HTTP port, even for one
>   bootstrap call, even just for HF auth seeding, even just for the
>   peer-id probe.
> - No second transport class hidden behind a feature flag.
>
> **Why we are aggressive about this**
>
> 1. ICE already gives us LAN P2P inside the existing WebRTC tunnel.
>    A separate LAN HTTP path is therefore strictly redundant on the
>    happy path; all it adds is a second way to be wrong on the sad
>    paths.
> 2. Two transports = two failure modes, two timeout policies, two
>    auth surfaces, two retry stories. We've already burned days on
>    bugs caused by "but in this branch we use the other one". Never
>    again.
> 3. The remote (central HF) flow is the strict subset where only
>    WebRTC works. If every code path also works in the remote case,
>    the LAN case automatically works too via ICE. The reverse is
>    not true.
>
> **What this means in practice**
>
> - The only network primitives the app may use to reach the daemon
>   are `RobotClient.fetch` (WebRTC `http_proxy`) and the SDK's own
>   DataChannel commands (`setHeadPose`, `setAntennas`, `wakeUp`, …).
>   When the user is on the same subnet as the robot, these
>   transparently run over a LAN P2P ICE pair.
> - BLE is NOT a daemon transport. It's a hardware-presence
>   side-channel used for **discovery**, **Wi-Fi provisioning** (the
>   `WIFI_*` GATT dance), and **`NETWORK_STATUS`** read-out so the UI
>   can render a connected/offline state. BLE never carries
>   `/api/...` payloads.
> - Anything that historically lived on `daemonFetch(host, ...)` (HF
>   auth seed, peer-id probe, daemon version probe) MUST be rerouted
>   through `RobotClient.fetch`. Bootstrap chicken-and-egg problems
>   (e.g. peer-id needed to open WebRTC) are solved by going to the
>   source of truth (`https://cduss-reachy-mini-central.hf.space`,
>   queried with the user's HF token via
>   `useResolvedPeerId` / `fetchRobotsFromCentral`), not by
>   re-introducing LAN HTTP.
> - There is no `src/daemon/daemonFetch.ts` anymore. If you find
>   yourself wanting to recreate it, stop and re-read this box.
>
> The same rule lives in `.cursor/rules/webrtc-only-transport.mdc`
> so AI agents working on this codebase get the message before they
> propose a "small" LAN HTTP fallback.

---

## 1. Goals and invariants

The app is a thin universal client for one Reachy Mini at a time. The
non-negotiable invariants are:

1. **Auth gate first.** The user signs in with Hugging Face *before*
   anything else renders. Sign-out collapses the entire app back to
   the gate.
2. **One discovery view.** Local (BLE) and remote (HF central) robots
   are listed side-by-side. The user does not have to choose a
   transport explicitly.
3. **One session screen.** Whatever the user picks, they enter the
   same `RobotSessionScreen` with the same stepper, the same
   post-connect chrome, and the same wake/sleep lifecycle.
4. **Single transport for daemon API.** Every daemon HTTP call goes
   through `RobotClient.fetch(path, opts)`, which today is always a
   WebRTC `http_proxy` command on the SDK's DataChannel. ICE picks a
   LAN host candidate when both peers are on the same subnet and a
   TURN-relayed remote one otherwise, so "prefer LAN when reachable"
   is automatic without dual code paths.
5. **Wake on arrival, sleep on departure.** The robot wakes up the
   moment a session goes "live" and goes back to sleep when the user
   leaves, regardless of how the bytes flowed.
6. **Graceful teardown.** Leaving a session always lands `endSession`
   on central, `goto_sleep` on the daemon, and a clean BLE
   disconnect, with a hard timeout so a flaky network never traps
   the user.

---

## 2. Cast of characters

| Actor | Where | Role |
|------|------|-----|
| **Mobile app** | Tauri (iOS / Android / macOS / Linux / Windows) | The UI the user taps on. |
| **Auth loopback server** | `127.0.0.1:8000` (Rust, Tauri command) | Captures the OAuth code from HF for ~10 min. |
| **BLE plugin** | `tauri-plugin-blec` + `btleplug` (Rust) | Opens GATT sessions to the robot. |
| **HTTP shim** | Tauri `daemon_fetch` (Rust `reqwest`) | Issues HTTP calls to the daemon, sidesteps WebView CORS / ATS. |
| **Reachy Mini daemon** | `reachy_mini/src/reachy_mini/daemon/` (Python, on the robot) | Exposes BLE GATT services + HTTP API + WebRTC producer. |
| **Reachy SDK** | `https://reachy.dev/sdk/v1/reachy-mini.js` | Loaded once into the WebView; opens the WebRTC peer connection and DataChannel. |
| **Conversation engine** | `src/conversation/conversation-engine.ts` | Native (no iframe) port of the Hugging Face Space app. Owns the orb, audio, and motion agents. |
| **Hugging Face OAuth** | `huggingface.co/oauth/*` | Issues the user's access token via PKCE. |
| **Hugging Face central** | `cduss-reachy-mini-central.hf.space` | Signaling rendezvous: lists the user's online robots and brokers WebRTC offers/answers. |

The legacy iframe-based conversation app is **gone**. The conversation
engine runs natively in the Tauri WebView and dispatches WebRTC
itself.

---

## 3. Global architecture

```
                      ┌────────────────────────────────────────────────┐
                      │                Mobile app (Tauri)              │
                      │                                                │
        user tap →    │ React screens (App, RemoteSignIn, Scan,        │
                      │   RobotSession, WifiSetup)                     │
                      │                                                │
                      │ Hooks:                                         │
                      │  ├ useRemoteHfToken  - localStorage HF token   │
                      │  ├ useRemoteRobots   - poll HF central         │
                      │  ├ useBleSession     - GATT singleton          │
                      │  ├ useWifiSetup      - BLE WIFI_* dance        │
                      │  ├ useHfAuth         - daemon-mediated auth    │
                      │  ├ useDaemonStatus   - probe /api/daemon/...   │
                      │  └ useReachySdk      - load SDK + seed token   │
                      │                                                │
                      │ Stores / modules:                              │
                      │  ├ robot-client      - WebRTC daemon client    │
                      │  ├ robotMotion       - wake/sleep state        │
                      │  └ dataChannelRegistry - SDK ↔ http_proxy DC   │
                      └────┬────────────┬──────────────────┬───────────┘
                           │ BLE        │ LAN HTTP         │ WebRTC (offer/answer
                           │            │ (HF auth boot-   │  via central SSE,
                           │            │  strap only)     │  data + audio + http_proxy)
                           ▼            ▼                  │
                  ┌──────────────────────────────────────┐ │
                  │         Reachy Mini daemon           │ │
                  │  BLE: status/cmd/response chars      │ │
                  │  HTTP: /api/daemon, /api/motors,     │◄┘
                  │        /api/move, /api/hf-auth, ...  │
                  │  WebRTC: GStreamer / aiortc producer │
                  │          + http_proxy DC handler     │
                  └──────────────────────────────────────┘
                           ▲
                           │ HTTPS (token + signaling)
                           │
                  ┌──────────────────────────────────────┐
                  │     Hugging Face cloud               │
                  │  /oauth/{authorize,token,userinfo}   │
                  │  /api/whoami-v2                      │
                  │  central /api/robot-status           │
                  │  central SSE signaling               │
                  └──────────────────────────────────────┘
```

Three communication channels, used by purpose:

- **BLE** for pre-connection discovery, first-time provisioning, and
  privileged-with-physical-access operations (Forget Wi-Fi).
- **LAN HTTP** is a narrow side-channel used only for the daemon-
  mediated HF auth bootstraps (`useHfAuth` and the auto-seed of
  `/api/hf-auth/save-token`). Those have to fire *before* the daemon
  has the HF token it needs to register on central, so they can't
  ride the WebRTC tunnel (which doesn't exist yet at that point).
- **WebRTC** for everything else: media (audio in/out), the SDK's
  control DataChannel, and the `http_proxy` tunnel that carries every
  daemon API call - LAN-discovered or remote alike. ICE picks a host
  candidate when both peers are on the same subnet (effectively a
  P2P LAN tunnel) and a TURN-relayed candidate otherwise.

---

## 4. Top-level state machine

```
                  ┌───────────────┐
                  │   AUTH GATE   │  <- no HF token in localStorage
                  │ RemoteSignIn  │
                  └──────┬────────┘
                         │ token + username
                         ▼
                  ┌───────────────┐
                  │     SCAN      │  <- BLE list + central list
                  │  ScanScreen   │     side-by-side
                  └──┬─────────┬──┘
              local  │         │  remote
              picked │         │  picked
                     ▼         ▼
                  ┌────────────────────────┐
                  │     ROBOT SESSION      │  <- single screen, two
                  │  RobotSessionScreen    │     transport branches
                  │ ┌────────────────────┐ │
                  │ │ phase: handshake   │ │
                  │ │ phase: engine      │ │
                  │ │ phase: live        │ │
                  │ │ phase: leaving     │ │
                  │ └────────────────────┘ │
                  └──────┬───────┬─────────┘
              back / sign-out    │ local + offline
                     │           ▼
                     │     ┌──────────────┐
                     │     │  WIFI SETUP  │
                     │     │ WifiSetup    │
                     │     └──────┬───────┘
                     │            │ on connected
                     ▼            ▼
                  ┌───────────────┐
                  │ (back to SCAN)│
                  └───────────────┘
```

Only four `Screen` values exist in `App.tsx`:
`scan | session | wifi-setup` (plus the implicit auth gate before the
router runs).

---

## 5. Auth gate (HF sign-in)

**File:** `src/screens/RemoteSignInScreen.tsx`,
`src/auth/oauthLoopback.ts`, `src/auth/useRemoteHfToken.ts`.

### 5.1. Why a gate

The HF token is the cornerstone:

- It identifies the user to HF central (which lists their robots).
- The Reachy SDK uses it to authenticate signaling and joins.
- It powers the HF user surface in the conversation engine.

Without a token, neither the remote section nor the conversation
engine can do anything useful, so we refuse to render the rest of the
app until we have one.

### 5.2. Flow (RFC 8252 PKCE loopback)

1. User taps **Sign in with Hugging Face** in `RemoteSignInScreen`.
2. Frontend calls `loginWithHuggingFace()`:
   1. Generate a PKCE pair (verifier 64 bytes, challenge SHA-256 +
      base64url).
   2. `invoke('start_oauth_callback', { expectedState })` boots the
      Rust loopback HTTP server on `127.0.0.1:8000`.
   3. `openExternalUrl(authorizeUrl)` opens the system browser at
      `https://huggingface.co/oauth/authorize?...&redirect_uri=
      http://localhost:8000/api/hf-auth/oauth/callback&...`.
3. User signs in on `huggingface.co` in the system browser.
4. HF redirects to `http://localhost:8000/api/hf-auth/oauth/callback?
   code=...&state=...`.
5. Rust loopback validates `state` and resolves the pending invoke
   with `{ code, state }`.
6. Frontend exchanges `code` for an access token via
   `POST https://huggingface.co/oauth/token` (PKCE: `client_id`
   in body, no secret).
7. Frontend calls `https://huggingface.co/oauth/userinfo` for the
   username.
8. `useRemoteHfToken.setToken(token, username)` persists into
   `localStorage` and seeds `sessionStorage.hf_token` so the SDK can
   read it.

### 5.3. Persistence

- **Token storage:** `localStorage['remote_hf_token']` and
  `localStorage['remote_hf_username']`.
- **SDK bridge:** `sessionStorage['hf_token']`, kept in sync by the
  hook (read at boot, mirrored on every set/clear).
- **Threat model:** localStorage is per-app on Tauri WebView, not
  shared with the system browser, not synced. Token loss = device
  loss; the user can revoke it on their HF account.

### 5.4. Sign-out

`App.handleSignOut()`:

1. If a BLE session is open, `disconnectDevice()`.
2. Drop the active `target` and route back to `scan`.
3. `useRemoteHfToken.clear()` removes localStorage + sessionStorage.

`App` re-evaluates `if (!token)` and renders the gate again. There is
no "logged out but on Scan" state.

### 5.5. Identity registered with HF

| What | Value |
|------|-------|
| OAuth client id | `71146982-8184-45a2-b05a-d561b3cd701d` (Pollen Reachy Mini) |
| Redirect URI | `http://localhost:8000/api/hf-auth/oauth/callback` |
| Scopes | `openid profile read-repos write-repos manage-repos inference-api` |

The redirect URI is intentionally identical to the daemon's so we
reuse the existing HF OAuth client without registering a new one.

---

## 6. Discovery (`ScanScreen`)

**File:** `src/screens/ScanScreen.tsx`. Two sources, one view.

### 6.1. Bluetooth section

| Aspect | Behaviour |
|--------|-----------|
| Source | `useBleSession.startScanning()` ; advertisements filtered by `name.includes('reachymini')` (case-insensitive, dashes stripped). |
| Filter | Service UUID `…abcdef3` (Reachy status service). |
| Refresh | Continuous: a `setInterval` re-issues `startScanning({ preserve: true })` every `SCAN_TIMEOUT_MS - 1s` so the stream never pauses. |
| Empty state | Three pulsing dots with "Scanning for nearby robots…" message. |
| Adapter off | Dedicated empty state with hint to enable Bluetooth in OS settings. |
| User action | Tap → `onRobotPicked(device)` → `App` sets `target = { kind: 'local', device }` and routes to `session`. |

### 6.2. Over-the-internet section

| Aspect | Behaviour |
|--------|-----------|
| Source | `useRemoteRobots(token, { pollMs: 30_000 })` calls `https://cduss-reachy-mini-central.hf.space/api/robot-status` with `Authorization: Bearer <hf_token>`. |
| Refresh | Auto-poll every 30s, manual via the refresh icon, or on token change. |
| Cache | Last known list is preserved across re-fetches and across leaving/coming back to the screen (no flash of empty). |
| Empty state | "No robots online" hint. |
| Failure state | "Couldn't reach Hugging Face" + reason + Retry. |
| User action | Tap → `onRemotePicked(robot)` → `target = { kind: 'remote', robot }` → routes to `session`. |
| Sign-out | Logout icon in section header → `onSignOutRemote` → `App.handleSignOut` (see 5.4). |

### 6.3. Robot identity coercion

Central's wire format is loose (`id` / `peerId` / `peer_id` have all
appeared). `extractRobotId(entry)` and `extractRobotName(entry)` in
`fetchRobotsFromCentral.ts` are the canonical adapters; UI must use
them and never read raw fields.

### 6.4. No deduplication

If the same physical robot appears as both a BLE entry and a central
entry (user is at home, phone has both Bluetooth and signed in to
HF), **both rows are shown**. Choosing between them lets the user
pick the cheaper transport (LAN) without forcing it.

---

## 7. Robot session (`RobotSessionScreen`)

**File:** `src/screens/RobotSessionScreen.tsx`. The unified post-pick
screen for both transports.

### 7.1. Phases

```
handshake ─► engine ─► live ─► leaving ─► (parent's onBack)
   │           │         │        │
   │ failure   │ failure │ back   │ teardown
   ▼           ▼         ▼        ▼
HandshakeFailureView (retry / wifi-setup)   await flush + onBack()
```

| Phase | What's mounted | What's running | What advances out |
|-------|----------------|----------------|-------------------|
| `handshake` | `StepperHeader` + `HandshakeRunningView` | LAN: BLE → Network → Daemon HTTP probe (sequential). Remote: peerId validation only. | Last step OK → `engine`. Failure → `HandshakeFailureView`. |
| `engine` | `StepperHeader` + `HandshakeRunningView` over a hidden `ConversePanel` | `ConversePanel` mounts the conversation engine, which negotiates the WebRTC session. | Engine reaches a non-transient `AppState` → `live`. |
| `live` | `SessionTopBar` + `ConversationArea` (`ConversePanel` visible) | Wake-up sequence kicked off in background. Daemon status pill polls every 5s. | User taps Back / Disconnect / Forget Wi-Fi → `leaving`. |
| `leaving` | "Disconnecting…" overlay | Engine teardown + motion sleep + BLE disconnect, sequentially, with a 3.5s timeout. | `onBack()`. |

### 7.2. Stepper

The same 4-step component, with mode-specific labels:

```typescript
const LOCAL_STEP_LABELS  = ['Bluetooth',    'Network', 'Daemon', 'Conversation'];
const REMOTE_STEP_LABELS = ['Hugging Face', 'WebRTC',  'Daemon', 'Conversation'];
```

Step advancement matrix:

| Step | Local advance trigger | Remote advance trigger |
|------|-----------------------|------------------------|
| 0 → 1 | BLE `connect()` succeeds | peerId is non-null on screen entry |
| 1 → 2 | `readNetworkStatus()` returns successfully (a null IP at this point becomes a step-2 error with `offerWifiSetup: true`, not an advance to step 2) | Engine `AppState` leaves the transient set (`connecting`, `auto-selecting`, `starting`) |
| 2 → 3 | `daemonFetch('/api/daemon/status')` returns 200 (and `ip` was non-null at step 1) | `useDaemonStatus` reports `kind: 'ok'` (first successful `http_proxy` probe) |
| 3 → done | Engine `AppState` ∈ `LIVE_ENGINE_STATES` | Same |

`LIVE_ENGINE_STATES` ⊃ `{ connected, authenticated, signed-out,
listening, user-speaking, processing, ai-speaking, error }`.
`TRANSIENT_ENGINE_STATES` = `{ connecting, auto-selecting, starting }`.

**Known UX trade-off (remote).** Because `connected` is in
`LIVE_ENGINE_STATES`, the moment the WebRTC peer connection is
established the screen flips to `live`. Steps 2 ('WebRTC') and 3
('Daemon') may both tick in the same render frame, so the user can
perceive them as "skipped". Acceptable: the conversation panel is
already showing its own loading state behind the scenes and the
information value of the intermediate ticks is low. If we ever need
to slow this down for visibility, we tighten `LIVE_ENGINE_STATES` to
`{ listening, user-speaking, processing, ai-speaking, error }`.

### 7.3. Handshake (LAN)

Inside `useEffect` keyed on `[phase, retryToken, target]`:

1. **Step 0 - Bluetooth.** If `connectedAddress !== device.address`,
   call `connectToDevice(device)`. Failure → `HandshakeError` at
   step 0.
2. **Step 1 - Network.** `readNetworkStatus()` reads the BLE
   `NETWORK_STATUS` characteristic and parses
   `parseNetworkStatus()`. Failure → step 1 error. `ip == null`
   (mode `OFFLINE` / `HOTSPOT`) → step 1 error with `offerWifiSetup:
   true` so the failure view shows "Set up Wi-Fi". Without an IP the
   robot can't reach HF central, which means our WebRTC tunnel could
   never come up regardless of how long we waited - the BLE check
   short-circuits that.
3. **Step 2 - Daemon.** Hand off to the engine: there's no direct
   HTTP probe anymore. The conversation engine mounts (DC opens) and
   `useDaemonStatus(robotClient)` lands a `/api/daemon/status` probe
   over the WebRTC `http_proxy`. Step 2 ticks "done" when that probe
   is ok, exactly like the remote flow.

On success, `setBleNetworkIp(ns.ip)` retains the LAN address as a
narrow side-channel for the daemon-mediated HF OAuth bootstraps
(`useHfAuth` and the auto-seed of `/api/hf-auth/save-token`), then
the phase flips to `engine`. The IP is **not** used for the main
daemon transport.

### 7.4. Handshake (remote)

Trivially short: the user already validated the peerId by selecting
the robot from central in `ScanScreen`. The handshake effect:

- Reads `extractRobotId(target.robot)`.
- If null, surfaces a "No peer id for this robot" error.
- Otherwise, advances to step 1 and immediately flips to `engine`.

### 7.4.5. Peer id resolution (`useResolvedPeerId`)

The conversation engine fast-paths `startSession(id)` when it
already has a central `peer_id`, otherwise it has to wait for an
SSE `robotsChanged` event from central, which is slower and
race-prone. So both modes resolve a `peer_id` up-front:

- **Remote.** The id is on `target.robot` (the user picked it from
  central's listing on the discovery screen). The hook
  short-circuits, no network call.
- **LAN/BLE.** The BLE advertisement does not carry a central id,
  and the daemon proxy cannot answer for it (proxy needs an open
  WebRTC, WebRTC needs the peer id - chicken-and-egg). The hook
  calls `fetchRobotsFromCentral(hfToken)` directly with the
  app-level HF token (see section 5) and matches the user's fleet
  entry by BLE device name. Strategy:
    1. fleet has 1 robot → use it (no name check needed).
    2. fleet has N robots, BLE name matches central
       `meta.name` / `name` (case-insensitive, after stripping
       non-alphanumerics) → use the matched entry.
    3. fleet has N robots, no name match → fall back to
       `robots[0]` and warn.

In LAN mode the hook never throws. Every failure path
(no token, central unreachable, empty fleet, no id field, …)
collapses to `peerId: null, resolved: true` and the engine takes
the slower SSE path. The lazy relay heal in `RobotSessionScreen`
also calls `refresh()` after a `healed` outcome.

### 7.5. RobotClient construction

```typescript
const robotClient = useMemo(() => createRobotClient(), []);
```

The factory in `src/robot-client/index.ts` returns a
`createWebRtcClient()` regardless of how the user got here. The
client is non-null from mount and stable across renders. Until the
SDK opens its DataChannel (`useReachySdk` + `ConversePanel`),
`client.fetch()` returns `{ status: 0, rawBody: 'no active webrtc
data channel' }`; consumers (`useDaemonStatus`, `setDesiredState`,
`probeDaemonVersion`) already render that as "still connecting…",
no special-casing required.

### 7.6. Engine mount via `ConversePanel`

`ConversePanel` is rendered as soon as `phase ∈ { engine, ready,
live, leaving }` for both LAN and remote (the WebRTC DC IS the
daemon transport, so we need it open from `engine` onward). It is
**always mounted in the same parent slot**; visibility is toggled
with CSS so the SDK / engine state survive the phase transition.

`RobotSessionScreen` passes the screen-owned `peerId` (resolved
through `useResolvedPeerId(target, hfToken)`, see 7.4.5) and
forwards engine state changes through `setEngineState`. The panel
itself doesn't need to know whether the user got here over BLE or
central.

`ConversePanel` itself is described in section 9.

### 7.7. Wake-up (gates the stepper's last step)

Triggered when both `daemonProbe.kind === 'ok'` and the engine has
left its transient set (DC open + at least one daemon-status probe
landed). Same gate for LAN and remote since both ride the same
`http_proxy`. The wake-up sequence runs in the **background** while
the stepper is still up; when `flushPending` resolves we flip the
phase from `engine` to `ready` and surface the "Start conversation"
CTA. Tapping the CTA flips to `live` and unhides the conversation
UI.

### 7.8. Teardown (entering `leaving`)

Triggered by Back, Disconnect from menu, or Forget Wi-Fi success.

```typescript
useEffect(() => {
  if (phase !== 'leaving') return;
  let settled = false;
  const finish = () => { if (settled) return; settled = true; clearTimeout(t); onBack(); };
  const t = setTimeout(finish, 3_500);

  setDesiredState(robotClient, 'sleeping');

  void (async () => {
    try { await flushMotionPending();    } catch {}
    try { await flushEngineLifecycle();  } catch {}
    if (isLocal && connectedAddress) {
      try { await disconnectDevice();    } catch {}
    }
    finish();
  })();
}, [phase]);
```

The order is intentional:

1. **`flushMotionPending()`** waits for the `goto_sleep` POST chain -
   `play/goto_sleep` → 2s settle → `set_mode/disabled`. This rides
   the WebRTC `http_proxy`, so we MUST run it before tearing the DC
   down.
2. **`flushEngineLifecycle()`** lands `endSession` on central; this
   also closes the DC by design.
3. **`disconnectDevice()`** (LAN only) closes the GATT session - no
   longer load-bearing for transport, just hygiene so the next BLE
   pickup starts from a clean session.

The `TEARDOWN_TIMEOUT_MS = 3_500` watchdog guarantees the user is
never trapped: if any step hangs, we drop to `onBack()` anyway.

### 7.9. Top bar and menu

`SessionTopBar` always renders, but the right-side menu is hidden
during `handshake` / `engine` / `leaving` to avoid the user tapping
"Disconnect" while we're still wiring things up.

Menu structure (`live` only):

| Section | Item | LAN | Remote |
|---------|------|-----|--------|
| Identity | HF sign-in / sign-out (daemon-mediated) | ✓ | - |
| Robot-side | Forget Wi-Fi (`ForgetWifiDialog`) | ✓ (BLE) | - |
| Destructive | Disconnect from robot (red) | ✓ | ✓ |

The remote variant has no daemon-mediated identity row because the
HF sign-in is a global (gate-level) concern - users sign out from
the Scan screen's section header.

### 7.10. Conversation area (`ConversationArea`)

Shown from `ready` onward (CTA covers the engine until the user taps
"Start conversation", then the orb / caption are uncovered in
`live`). Contains:

- The `ConversePanel` with the orb / mic / settings UI.
- A floating `DaemonStatusPill` (top-right) with `transportLabel:
  'WebRTC'`, fed by `useDaemonStatus(robotClient)`. The pill shows
  the transport health, not the discovery path.
- Optional `BottomNavigation` with two tabs: `Converse` and `Apps`
  (signed-in-only - works in both LAN and remote modes through the
  WebRTC `http_proxy`). The `AppsPanel` lists installed daemon apps
  and lets the user start/stop them.

There is **no second OAuth surface here**. Earlier iterations
covered the panel with an `HfLoginOverlay` whenever the LAN daemon
reported `!isAuthenticated`, but the user has already authenticated
once at the app entry gate (`RemoteSignInScreen`, see §1). The
`isAuthenticated` flag on the daemon is now used exclusively to
gate the `Apps` tab (which needs the daemon-held token to start
embedded apps). The auto-seed flow in `RobotSessionScreen` pushes
the gate token to the daemon on entry; failures are surfaced via
the top-bar HF menu, not as a fullscreen overlay.

---

## 8. Daemon API client (`RobotClient`)

**Files:** `src/robot-client/{types,index,webrtcClient,
dataChannelRegistry}.ts`.

### 8.1. Why an abstraction

Every screen post-discovery wants to call daemon endpoints. The
client gives them a single shape with no transport branching:

```typescript
const resp = await client.fetch<DaemonStatus>('/api/daemon/status', {
  method: 'GET',
  timeoutMs: 4000,
});
if (resp.ok) {
  console.log(resp.data?.version);
}
```

Under the hood every call ends up as an `http_proxy` command on the
WebRTC DataChannel. The "prefer LAN when reachable" intent is
delegated to ICE: it picks a host candidate when both peers are on
the same subnet and a TURN-relayed remote one otherwise. We don't
ship a separate LAN HTTP client anymore - the duplication wasn't
paying for itself.

A handful of bootstrap calls keep using `daemonFetch` directly with
a LAN IP captured during the BLE handshake (`useHfAuth` and the
auto-seed of `/api/hf-auth/save-token`). They legitimately need a
direct socket because they happen *before* the daemon has the HF
token it would need to be visible on central, i.e. before the
WebRTC tunnel can be brought up at all.

### 8.2. Interface

```typescript
interface RobotClient {
  readonly transport: 'webrtc-proxy';
  fetch<T>(path: string, opts?: RobotFetchOptions): Promise<RobotResponse<T>>;
}

interface RobotFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;          // JSON-serialisable
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface RobotResponse<T> {
  status: number;          // 0 means transport-level failure
  ok: boolean;             // true iff status in [200, 300)
  data: T | null;          // parsed JSON or null
  rawBody: string;         // always a string for diagnostics
}
```

The `transport` discriminator stays as a union form for forward
compatibility, but only `'webrtc-proxy'` is implemented today.

### 8.3. WebRTC `http_proxy` transport

The remote transport sends a JSON payload on the SDK's existing
DataChannel:

```json
{
  "type": "http_proxy",
  "request_id": "<uuid>",
  "method": "POST",
  "path": "/api/move/play/wake_up",
  "body": null,
  "headers": null,
  "timeout_s": 3.6
}
```

The daemon's `_async_http_proxy` handler (in
`reachy_mini.daemon.backend.abstract.AbstractBackend`) forwards the
request to its own loopback HTTP server and replies with:

```json
{
  "type": "http_proxy_response",
  "request_id": "<uuid>",
  "status": 200,
  "body": { ... },
  "headers": { ... },
  "error": null
}
```

`request_id` matching is FIFO-free: each pending request lives in a
`Map` until either the response or a timeout cancels it.

### 8.4. DataChannel registry

The SDK is the one that opens the DataChannel (the GStreamer producer
on the robot only negotiates the application channel via SDP at
session start; we cannot open a parallel one). The registry is a tiny
pub/sub:

```typescript
setActiveDataChannel(dc: RTCDataChannel | null): void
getActiveDataChannel(): RTCDataChannel | null
subscribeDataChannel(fn: Listener): Unsubscribe
```

`useReachySdk` is responsible for calling `setActiveDataChannel(dc)`
whenever the SDK opens or closes a session. The WebRTC client
subscribes once and re-attaches its `message` listener on every DC
swap.

### 8.5. Failure semantics

| Cause | Outcome |
|-------|---------|
| No DC yet | `{ status: 0, rawBody: 'no active webrtc data channel' }` |
| Daemon's loopback errors | DC open, response carries the daemon's actual `status` (e.g. 502) |
| Per-call timeout | cancels the pending entry, returns `{ status: 0, rawBody: 'webrtc proxy timeout after Xms' }` |
| DC closed | `failAllPending('webrtc data channel closed')` resolves all pending with `{ status: 0, ... }` |

`useDaemonStatus` translates the `status: 0 / no active …` case into
a soft "Connecting through WebRTC…" message instead of a hard error,
which keeps the daemon pill calm during the brief window between
handshake completion and DC opening.

---

## 9. Conversation engine (`ConversePanel`)

**Files:** `src/conversation/ConversePanel.tsx`,
`conversation-engine.ts`, `useReachySdk.ts`,
`openai-realtime.ts`, motion agents in `head-wobbler.ts`,
`antennas.ts`, `move-player.ts`.

### 9.1. Mount gating

Two gates must clear before the engine is mounted:

1. **SDK ready.** `useReachySdk()` loads
   `https://reachy.dev/sdk/v1/reachy-mini.js` once and resolves
   `isReady`.
2. **Token ready.** `sessionStorage.hf_token` is populated by the
   app-level OAuth gate (see §5); both LAN and remote rely on the
   same value.
3. **Peer id resolved.** `useResolvedPeerId(target, hfToken)` has
   resolved to a string-or-null. In remote mode the value comes
   directly from `target.robot`; in LAN mode the hook hits Hugging
   Face central directly with the user's HF token and matches the
   fleet entry by BLE device name (see §7.4.5).

### 9.2. Module-level lifecycle serialisation

Mount and unmount of the engine are queued behind a module-global
promise:

```typescript
let engineLifecyclePromise: Promise<void> = Promise.resolve();
```

Why: React.StrictMode double-invokes effects in dev, and even in
production a fast re-render can land mount₂ while mount₁'s
unmount is still settling. Two engines alive at once would multiplex
on central's SSE and the second peer connection would reject ICE
candidates from the first session ("remote description was null").
The lock guarantees a strict mount-N → unmount-N → mount-N+1 order.

`flushEngineLifecycle()` waits on the chain and is called by
`RobotSessionScreen` during teardown.

### 9.3. Lazy daemon-relay heal

`useDaemonRelayHealing(robotClient)` is the on-demand recovery path
for both modes. It probes the daemon's relay status through the
existing `RobotClient` (no second transport) and POSTs
`/api/hf-auth/refresh-relay` only if the engine reports itself
stuck past the lazy heal budget. Possible outcomes:

| outcome | Meaning | Action in `RobotSessionScreen` |
|---------|---------|---------------------------------|
| `noop` | Daemon was healthy when polled | Don't remount the engine - it's just a slow happy path. |
| `healed` | Daemon ↔ central handshake refreshed | Refresh peer id and bump `conversationRemountKey`. |
| `failed` / `unreachable` | Heal didn't recover the relay | Surface the watchdog CTA when its timer fires. |

### 9.4. Watchdog

20s timer armed on entry to any state in `TRANSIENT_STATES = {
connecting, connected, auto-selecting, starting }`, disarmed on entry
to a non-transient state. Trip → "Robot unresponsive" UI with Retry,
which bumps `retryKey` and re-runs all gates.

### 9.5. State observation contract

`onAppStateChange` is invoked on every `AppState` transition, after
internal watchdog bookkeeping, in the engine's order. The callback
identity is captured via a ref so the parent can swap it across
renders without re-mounting the engine. Throws from the callback are
swallowed so a bad subscriber can never wedge the engine.

`AppState` values in order of progress:

```
connecting → connected → authenticated → signed-out
                                       ↘ auto-selecting
                                            ↓
                                          starting → listening
                                                   ↘ user-speaking
                                                   ↘ processing
                                                   ↘ ai-speaking
                                                   ↘ error
```

`RobotSessionScreen` watches this stream and flips to `live` on the
first non-transient observation.

---

## 10. Robot motion lifecycle (`robotMotion`)

**File:** `src/daemon/robotMotion.ts`. The single source of truth for
"is this robot supposed to be awake or asleep right now?".

### 10.1. API

```typescript
type RobotState = 'awake' | 'sleeping';

setDesiredState(client: RobotClient, desired: RobotState): void;
flushPending(): Promise<void>;
resetRobotMotion(): void;
```

### 10.2. Sequences

```
wake:
  POST /api/motors/set_mode/enabled       - torque on
  wait 150 ms                              - absorb serial-bus init
  POST /api/move/play/wake_up              - ~2 s trajectory

sleep:
  POST /api/move/play/goto_sleep           - ~2 s trajectory
  wait 2000 ms                             - trajectory finish
  POST /api/motors/set_mode/disabled       - torque off (floppy)
```

The wake-up settle is short on purpose: too brief and the daemon's
serial bus often hits a couple of "Serial I/O recovered" retries at
the very moment the wake_up trajectory starts pushing goal-positions
(perceived by the user as "robot snaps then freezes then resumes"),
too long and the Dynamixel snap-to-goal of the `enable` step itself
becomes visible. See the doc comment at the top of `robotMotion.ts`.

All four POSTs go through `client.fetch`, i.e. the WebRTC
`http_proxy`.

### 10.3. Coalescing

The store keeps `desiredState` and `currentState`. `setDesiredState`
just mutates `desiredState` and chains `reconcile(s)` onto a
single-promise queue. Inside `reconcile`:

```typescript
while (s.currentState !== s.desiredState) {
  if (s.desiredState === 'awake') { await doWakeUp(s.client); s.currentState = 'awake'; }
  else                            { await doGotoSleep(s.client); s.currentState = 'sleeping'; }
}
```

Five rapid `setDesiredState` toggles during a 2s sleep animation will
finish the in-flight sequence, re-read `desiredState`, and execute at
most one more sequence to land on the final target. This is what
makes wake-on-mount + sleep-on-unmount safe under React.StrictMode's
double-invoke.

### 10.4. Session stickiness

`session.key` is a constant (`'webrtc-proxy'`) since we ship a
single transport. A different `RobotClient` instance (e.g. re-render
with a fresh `useMemo` output, watchdog remount) updates the active
client pointer in place but keeps the existing session, so a stale
`wake` already in-flight isn't dropped on the floor.

### 10.5. No cancellation

Once a wake or sleep sequence has issued its first POST, it runs to
completion. Cancelling mid-sequence would leave the robot half-armed.
Newly queued requests can be superseded though - that's what
`desiredState` coalescing is for.

---

## 11. WiFi setup flow (`WifiSetupScreen`)

**File:** `src/screens/WifiSetupScreen.tsx`. Reached only from a
LAN-mode `HandshakeFailureView` with `offerWifiSetup: true`. Same
high-level flow as before, summarised here.

| Sub-phase | Visible affordances | BLE traffic |
|-----------|---------------------|-------------|
| PIN idle | input + Continue + Back | - |
| PIN running | spinner; input disabled, Back hidden | `PIN_xxxxx` |
| PIN failed | error + Try again | - |
| Picker idle | NetworkSelect + password + Connect + Back | `WIFI_SCAN`, `WIFI_STATUS` |
| Connecting (fullscreen) | rocket animation; nothing else tappable | `WIFI_CONNECT <ssid> <psk>` then poll `WIFI_STATUS` every 3s, then poll `NETWORK_STATUS` + LAN `daemonFetch` every 2s |
| Connect failed | error + retry | - |

Watchdog: 90s on the auto-probe phase. On success,
`onConnected()` returns control to `App`, which routes back to the
`session` screen with the same `target` and the BLE session intact.

---

## 12. Forget Wi-Fi flow (`ForgetWifiDialog`)

**File:** `src/components/ForgetWifiDialog.tsx`. Self-contained
dialog opened from `RobotSessionScreen`'s menu (LAN only).

Sequence (all over the persistent BLE session):

1. **Auth** - `PIN_xxxxx` (user-provided).
2. **Read** - `WIFI_STATUS` JSON; extract `connected` SSID.
3. **Forget** - `WIFI_FORGET <ssid>`.
4. On success, the dialog calls `onForgotten()` which delegates to
   `RobotSessionScreen.handleBack()`. From there the regular
   `leaving` teardown runs (engine → motion → BLE disconnect), and
   the user lands back on `Scan`. The robot is now reopening its
   hotspot - any cached IP is stale, so we **must** disconnect BLE
   here.

---

## 13. Error / edge cases checklist

| Situation | Outcome |
|-----------|---------|
| Sign-in browser closed without completing | After 10 min, Rust loopback rejects with `Timeout` → friendly French-or-English error in `RemoteSignInScreen`. Cancel button issues `cancel_oauth_callback`. |
| BLE adapter off | `ScanScreen` Bluetooth section shows "Bluetooth is off" empty state. Adapter monitor hooked via `useInitBleListeners`. |
| HF central temporarily unavailable | Remote section shows "Couldn't reach Hugging Face" + last cached list (no flash of empty). |
| Token rejected (401/403) | Remote section error + Retry; user usually needs to sign out and back in. |
| BLE connect timeout | `HandshakeError` at step 0; Back + Retry visible. |
| Wrong Wi-Fi (BLE shows no IP) | `HandshakeError` at step 1 + "Set up Wi-Fi" CTA + Retry. The WebRTC tunnel can't come up at all without an IP, so we bail before mounting the engine. |
| WebRTC DC takes >1s to open | Daemon pill shows "Connecting through WebRTC…", stepper stays on "Daemon" until first `http_proxy` round-trip succeeds. |
| Engine stuck in transient state >20s | `ConversePanel` watchdog trips, "Robot unresponsive" + Retry. |
| User backs out mid-wake | Sleep request queued; `flushMotionPending` waits up to 3.5s; engine teardown sends `endSession` first so the WebRTC tunnel survives long enough for the sleep POSTs. |
| Daemon zombie-relay | LAN: auto-heal via `/api/hf-auth/refresh-relay`. If unavailable, surface a "SSH and restart the daemon" instruction with a verbatim command. |

---

## 14. Coding conventions specific to this flow

1. **Prefer `RobotClient.fetch` over `daemonFetch` for new code.** The
   client is what makes a call site work without owning a transport.
   Direct `daemonFetch` callers exist today and are deliberately kept
   as narrow LAN side-channels because they fire *before* a
   `RobotClient` can do useful work, or only make sense on LAN:
     - `localHttpClient` (it is the LAN transport).
     - `WifiSetupScreen` (auto-probe after `WIFI_CONNECT`: BLE has
       just told us the new IP, and the whole point is to verify HTTP
       reachability before declaring the setup successful).
     - `useHfAuth` (daemon-mediated OAuth status / start / logout
       endpoints; only used in LAN-mode menu).
   New code that doesn't fit one of those four shapes should use a
   `RobotClient`.
2. **Never call wake/sleep POSTs by hand.** Always go through
   `setDesiredState`. Multiple call sites and StrictMode mean
   coalescing is mandatory.
3. **Never bypass the BLE session store.** `useBleSession` is the
   single owner; opening a parallel `connect()` corrupts the
   command queue.
4. **Never read `localStorage['remote_hf_token']` directly.** Use
   `useRemoteHfToken` so `sessionStorage` stays in sync for the SDK.
5. **Never special-case transport in screen logic.** The whole point
   of `RobotClient` + `RobotSessionScreen` is one code path. If you
   find yourself writing `if (target.kind === 'remote') ... else
   ...` inside a child, push the branch up to the screen and pass
   pre-computed values down.

---

## 15. Debugging cheat sheet

1. **WebView devtools console** - structured logs at every
   transition: `[ble]`, `[robot-client]`, `[robotMotion]`,
   `[ConversePanel]`, `[remote]`, `[transition]`.
2. **`yarn tauri:dev` terminal** - `tauri_plugin_blec` Rust logs
   with `RUST_LOG=info,tauri_plugin_blec=debug` show GATT events.
3. **Daemon logs on the robot** - `journalctl -u
   reachy-mini-daemon -f` shows BLE command traffic, HTTP requests,
   and `http_proxy` dispatches.
4. **HF central observability** - `curl https://cduss-reachy-mini-
   central.hf.space/api/robot-status -H "Authorization: Bearer
   $HF_TOKEN"` confirms what the central thinks is online.
5. **WebRTC dev page** - `chrome://webrtc-internals` (when running
   the app under desktop Chrome via `yarn dev`) shows ICE
   candidates, DC state, and bytes sent/received.

If a probe fails when the user expects it to succeed, the answer is
almost always one of:

- Mac firewall blocking inbound connections to the Tauri WebView
  (unlikely - we go through Rust `reqwest`).
- Daemon bound to `127.0.0.1` only (must listen on `0.0.0.0:8000`).
- Phone on guest Wi-Fi with AP isolation enabled.
- Robot's relay desynced from central (LAN: auto-heal endpoint
  available; remote: refresh the Scan list to re-fetch
  `/api/robot-status`).
