# Robot (Python) apps from the phone

Status: first implementation, branch `feat/python-apps`. It needs the daemon
change on `reachy_mini` branch `feat/apps-rpc-relay`.

## What it does

The Apps tab now covers both kinds of Reachy Mini app:

| | JS apps (unchanged) | Python apps (new) |
|---|---|---|
| Runs on | the phone, in an iframe | the robot, as a daemon-managed process |
| Catalog | `GET {website}/api/js-apps` | `GET {website}/api/apps`, keep `extra.isPythonApp` |
| Launch | release the WebRTC session, the iframe dials in | `apps.start` over the live session (no handoff) |
| Install | none | `apps.install_space`, a background job on the robot |

Where it shows in the UI:
- **Launcher**: an "On your robot" panel lists the installed apps with their
  run state, and offers one-tap start and stop.
- **Store**: a "Web apps / Robot apps" switch. Robot apps form a searchable
  list (403 today) with Get / Open buttons.
- **App sheet**: install, start, stop, restart, update and uninstall. It shows
  live install logs and crash details. Replacing a running app or uninstalling
  asks for confirmation first.

The conversation app does not appear in the robot-apps catalog, because the
Talk tab owns it.

## Why it goes through JSON-RPC

The daemon's REST API (`/api/apps/*`, which the desktop app uses) sits behind
`LocalNetworkGuardMiddleware`, so only the LAN can reach it. The phone talks to
the robot from anywhere through central signalling and the WebRTC data channel.
The daemon already relays JSON-RPC over that channel (`jsonrpc_relay.py`), and
`apps.*` is answered by the daemon itself.

Before this change, the relay only answered `start / stop / status` and an
inline `install` that reported no progress. The daemon branch adds:

| Method | Params | Result |
|---|---|---|
| `apps.list_installed` | – | `{apps: [{name, description, url, space_id, title, emoji, private, custom_app_url}]}` |
| `apps.install_space` | `{space_id: "owner/repo"}` | `{job_id, name}`. The Space is resolved on the Hub with the robot's token, so the owner's private Spaces work too. It must carry the `reachy_mini_python_app` tag. |
| `apps.remove` | `{name}` | `{job_id}` |
| `apps.update` | `{name}` | `{job_id}` |
| `apps.job_status` | `{job_id}` | `{job_id, command, status, logs}` |
| `apps.restart` | – | status. The phone's session is kept (`keep_remote`); the REST restart evicts it. |
| notification `apps.job_progress` | – | `{job_id, command, status, line, final}`, one per log line plus a final event |

Error `data.reason` values: `busy` (another job is running), `app_running`,
`startup_app`, `not_found`, `not_running`, `unknown_job`, `invalid_params`.
`apps.stop` with nothing running now answers `not_running`; it used to answer
`internal_error`. When `apps.restart` stops the app but fails to start it
again, it answers `already_running`, so the app is now stopped.

A crashed app (state `error`) no longer blocks `apps.remove` or `apps.update`.
The relay clears the slot first.

On the phone, `features/robot-apps/controller.ts` keeps one controller per
robot, so an install survives tab switches and reconnects.
- It polls `apps.status` every 3 s, and only while the Apps tab is visible
  over a live session.
- It follows jobs through notifications, with `job_status` as a fallback for
  events lost while the data channel was down.
- It detects old daemons (`method_not_found`) and then hides the management
  UI. A running app is still shown so it can be stopped.
- It goes **offline** while the session is down or re-dialing. "Down" means
  the host phase isn't `live`, e.g. a signalling drop or an iframe handoff;
  "re-dialing" means the SDK's in-place `sessionReconnecting`, after an ICE
  drop on a Wi-Fi blip.
  - While offline, actions are refused locally and the UI says "Reconnecting
    to Reachy…".
  - When it comes back, it re-syncs at once: the installed list, the slot,
    and a forced `job_status` poll.
  - A call that fails without a JSON-RPC reason is reported as reconnecting
    (closed data channel, flushed calls) or as "didn't answer in time"
    (timeout), never as a robot refusal.

## Gaps found in the pipeline

Fixed on these branches:
1. **The conversation teardown stopped any app.** `robot-conversation.stop()`
   called `apps.stop` without checking what was running. A refused start
   ("busy with X") followed by a tab switch killed the app the user had
   launched. It now calls `stopConvApp()`, which only stops the conversation
   app.
2. **No list / remove / progress over WebRTC.** Fixed by the daemon verbs
   above.
3. **The RPC `apps.install` matched by name, inline.** It had no progress, a
   20 s default timeout, no private Spaces, and a name collision risk across
   authors. `apps.install_space` takes the Space id instead. The old verb is
   kept for the Talk tab.
4. **Concurrent installs could corrupt the shared apps venv.** The RPC verbs
   refuse with `busy` while any app job runs. That covers jobs started over
   REST and the legacy inline `apps.install`. Two concurrent `install_space`
   calls are also covered: the check runs again after the Hub lookup.
5. **A crashed app blocked the Talk tab for 60 s.** `already_running` counted
   as success, and the readiness poll then talked to a dead app. The Talk tab
   now clears a crashed slot first. It accepts `already_running` only when the
   conversation app is the one running.
6. **Starting an app raced the Talk tab's teardown.** Leaving the Talk tab
   stops the conversation app without waiting for it, so a start right after
   could hit a slot still `stopping`. The controller now waits for the slot to
   be free.

Still open. Connection-level issues are tracked separately from this
feature: the robot's periodic Wi-Fi stalls and gateway losses, re-dials to a
stale central peer, and the libnice abort.
1. **The robot slot stays `free` after a stop.** When an app exits, the
   daemon frees the slot instead of handing it back to the phone's
   `remote_session`. On device (2026-10-06), no idle-reset sleep fired after
   any stop or restart: motors stayed enabled and the session stayed usable.
   The phone's traffic keeps cancelling the reset. Still, while the slot reads
   `free`, the daemon's bookkeeping says nobody holds the robot.
2. **Apps that release media kill the phone's session.** An app built with
   `media_backend="no_media"`, or one that calls `release_media()`, stops the
   media server and the central relay, which drops the WebRTC session. The
   phone reconnects as a control-only session. Nothing tells the user that the
   app caused the drop.
3. **App web UIs (`custom_app_url`, e.g. `:7860`) are LAN-only and HTTP.**
   They can't be opened from a remote phone, and the WebView's mixed-content
   rules would block them even on the LAN. Fixing this needs either an HTTP
   proxy over the data channel or the app exposing its settings over `/rpc`.
   It is not surfaced in the UI yet.
4. **Two motor drivers.** A running Python app and the phone (telepresence,
   first wake-up) can both command the motors. So can a JS iframe app: while a
   local app holds the slot, the daemon accepts a new remote session as
   control-only. The conversation engine already stands down
   (`isAnotherAppDrivingRobot`); the other surfaces don't. Opening a JS app
   while a Python app runs should at least ask for confirmation.
5. **Removing the startup app** is refused over RPC (`startup_app`), because
   re-arming the antenna watcher needs FastAPI state the relay doesn't have.
   The phone has no startup-app control yet.
6. **Updates are always offered.** `apps.check_updates` is not exposed yet, so
   "Update" means "reinstall latest".
7. **Daemon-version gate.** Daemons older than the relay (< 1.10) don't answer
   JSON-RPC at all, so the first `apps.list_installed` times out (15 s) instead
   of failing fast. A version check like the Talk tab's `MIN_DAEMON_VERSION`
   would fix this.
8. **The REST app routes still don't check the job register.** A desktop
   install started during a phone job runs concurrently. Adding the same
   `busy` check (409) there is a separate decision for the desktop app.
9. **The phone can't see jobs started over REST.** It only hears
   `apps.job_progress` for jobs started through the relay, so during a desktop
   install its buttons stay enabled. The daemon then refuses with `busy`, and
   the sheet shows why.
10. **libnice abort on connect.** On the first connection of the device test,
    the daemon aborted on a libnice assertion (`conncheck.c:987`) and systemd
    restarted it. This is unrelated to apps; the app showed "Connection
    interrupted" and the second attempt connected.

## Testing

- Unit tests: `features/robot-apps/*.test.ts` on the phone, and
  `tests/unit_tests/test_jsonrpc_relay.py` on the daemon.
- UI without a robot: `yarn dev`, then open `/harness.html`. The harness runs
  the Apps tab against an in-memory daemon (`src/dev/fakeRobotApps.ts`). Add
  `?crash` to make started apps crash after 3 s.
- On a robot (done 2026-10-06): a release APK on Android 10 (Poco M3,
  WebView 147) against the daemon branch, over central with TURN, driven by
  Chrome DevTools over USB. Everything below passed, cross-checked against the
  daemon's REST state and logs:
  - **Installed list:** shown over WebRTC; the conversation app is hidden.
  - **Install:** progress lines stream into the sheet; about 15 s. Installing
    while the app is in the background catches up when it comes back.
  - **Start:** the phone keeps its session (`kept remote session`).
  - **Restart:** about 2 s.
  - **Stop:** the robot returns to zero, no idle sleep.
  - **Replace:** asks first, then switches apps.
  - **Talk tab:** while an app runs, it says "busy with X", and switching tabs
    afterwards leaves the app running (the regression this branch fixes).
  - **Crash (SIGKILL):** the panel and sheet show "Crashed" with the exit code,
    and "Start again" recovers.
  - **Uninstall a crashed app:** the daemon clears the slot first.
  - **Update:** a forced reinstall, about 2 minutes.
  - **Concurrent install** (REST job running): refused with `busy`.
  - **Phone leaves while an app runs:** the app keeps running; the phone
    reconnects as control-only, sees the app running, and can stop it.
- Re-run on 2026-10-15 with the committed branches: this branch's release APK
  on a Fairphone 4, against reachy_mini `feat/apps-rpc-relay` pip-installed on
  the robot. The matrix above passed again, plus the link-drop handling:
  - SDK re-dial: "Reconnecting to Reachy…", actions disabled, a tap never
    reaches the robot, and everything comes back after the re-dial.
  - A real Wi-Fi outage: the same banner, then a re-sync within 2 s of
    reconnecting (a stale "Running" was cleared).
  - Launching an app does not stall the daemon's data channel. In four trials
    (warm, cold after reinstall, restart) the phone never saw more than ~1.6 s
    of silence, against a re-dial threshold of 8 s; the gaps it did see were
    the robot's periodic Wi-Fi stalls.
