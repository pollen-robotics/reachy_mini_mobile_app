# Agent instructions

This file is the entry point for AI coding assistants (Cursor, Claude
Code, Copilot, Windsurf, Cody, Continue, etc.) and for new human devs.
Read it before touching the codebase.

## What this app is

Tauri 2 client (iOS / Android / desktop) for **Reachy Mini**. The user
signs in with Hugging Face, picks a robot from their account, and gets:

1. A live conversation panel (orb + audio bridge + HF realtime backend).
2. An apps catalog mounted as iframes (Hugging Face Spaces).
3. A robot tab with camera feed + audio sliders + manual head joystick.

The robot is assumed to be already provisioned (on Wi-Fi, advertising
itself on the HF central signaling Space). First-time Wi-Fi setup is
handled outside this app for now.

Design docs live in `docs/`.

## Architecture (read this before making changes)

The codebase is organised into three horizontal tiers under `src/`:

```
src/
├── shared/        cross-cutting helpers (Tauri/browser/env wrappers)
├── features/      non-UI logic (one folder per feature)
└── ui/            all React UI (itself layered: design < widgets < panels < screens)
```

Plus the entry-point files at the root:

```
src/
├── main.tsx        React + theme + ErrorBoundary bootstrap
├── App.tsx         Top-level screen router (auth gate, screen state)
├── theme.ts        MUI theme (light + dark)
├── queryClient.ts  TanStack Query setup
├── vite-env.d.ts   Vite env type augmentation
├── assets/         Static SVGs / images
└── vendor/         Vendored Reachy Mini SDK + types
```

### `features/` - the logic layer

```
features/
├── auth/           HF OAuth + token storage + central robot listing
├── apps/           HF Hub app catalog fetching + embed URL builder
├── robot-session/  RobotSession class + lifecycle helpers + React hook
└── conversation/   HF realtime voice engine + audio bridge + motion + tools + memory
```

Each feature folder contains its own `types.ts`, services, React
hooks. Same-folder relative imports (`./X`) are fine; cross-feature
imports must go through `@/features/<other>/...` aliases.

#### `features/robot-session/` - SESSION layer (B + C)

`RobotSession.ts` is the **central class**. It owns the SDK robot ref,
the selected peer id + the SDK's robot list cache, the `established`
flag and the motor-mode dedup cache. It composes `SessionGuard` (the
`expectedStop` counter) and `VideoStreamCache`. It exposes lifecycle
methods that wrap the SDK with the right preconditions and bookkeeping:

  - `start(opts)` - retry-aware bring-up (libnice crash recovery)
  - `wakeUp()` - hard-bounded wake trajectory
  - `sleepAndDisable()` - sleep + disable motors + record cache
  - `stop()` / `disconnect()` / `ensureConnected()` - low-level ops
  - `release()` - **iframe handoff sequence** (full release + disconnect)
  - `reacquire(opts)` - **bring session back after release** (no wakeUp)
  - `attachVideo(el)` - bind + cache replay for late mounters

Sibling modules in `features/robot-session/` provide the helpers
(`start-session.ts`, `physical.ts`, `session-guard.ts`,
`video-cache.ts`, `transport-monitor.ts`, `dc-health.ts`,
`background-resilience.ts`, `sdk-bootstrap.ts`,
`sdk-types.ts`, `token-hash.ts`, `lifecycle-queue.ts`).

The conversation engine instantiates ONE `RobotSession` per
`mountConversation` and uses it as a building block for the
high-level conversation flow (which it owns via the FSM + the
HF realtime / motion / tools / audio pipeline).

#### `features/conversation/` - CONVERSATION layer (D)

`engine/conversation-engine.ts` is the orchestrator. It owns the FSM,
the conversation pipeline (HF realtime client, motion controllers,
tool-call handler, audio level monitors), and the host-facing handle
(`startConversation`, `setMicMuted`, `requestStop`, …). It DRIVES the
session for everything session-related (start, wakeUp, release, …)
and parks the FSM around the session's transitions.

**Extension point**: `tearDownConversationPipeline({ glide })` inside
the engine is the single place every "stop the D layer" path goes
through (`stopConversation`, `releaseSessionKeepAwake`, `teardown`).
Adding a new pipeline actor (vision module, motion controller, audio
helper) means wiring it there once instead of in three call-sites.

**Audit point**: every timing budget that drives the session
lifecycle and the iframe handoff lives in
`features/robot-session/timings.ts` (`SESSION_TIMINGS`,
`APP_HANDOFF_TIMINGS`). Retuning a budget is a one-file edit.

### `ui/` - the React UI layer

```
ui/
├── design/        Tokens + atomic primitives (TransportChip, RobotAvatar, ScreenTransition, ErrorBoundary, ...)
├── widgets/       Composable bricks reused across panels (video-feed, audio-controls, head-control, camera-overlay)
├── panels/        Feature compositions mounted into screens (conversation, apps-list, robot)
└── screens/       Top-level routes (Splash, RemoteSignIn, WelcomeBack, Scan, RobotSession)
```

### `shared/` - cross-cutting helpers

Lowest tier. Currently just `shared/tauri/openUrl.ts`. Add new helpers
here when they're truly cross-cutting (e.g. browser API wrappers,
env-var readers, future logger).

## Layer rules (ESLint-enforced)

The dependency graph is unidirectional: each tier can only import from
tiers below it. Violating these triggers a `no-restricted-imports`
ESLint error with a custom message.

```
ui/screens/   ──┐
ui/panels/    ──┤
ui/widgets/   ──┤── may import from features/, shared/, vendor/, design/, MUI, React
ui/design/    ──┘── may import from itself + design tokens only

features/*    ────── may import from peer features/, shared/, vendor/
                      MUST NOT import from ui/

shared/       ────── lowest layer; depends on nothing else in src/
```

**Cheat sheet** for the most common confusions:

- A widget needs `RobotSessionHandle` for typing? OK,
  `widgets/X.tsx` can import from `@/features/session/useRobotSession`.
  Importing for **types/hooks** is the whole point of the layer.
- A panel needs to share a sub-component with another panel? Extract
  the sub-component to `ui/widgets/`, do not cross-import between
  panels.
- A feature wants to render a toast? Either expose state and let the
  UI render it, or accept that the toast lives in `ui/`. Features
  must NOT import React components from `ui/`.

Run `yarn lint` to check.

## Where do I put X?

| If you want to add... | Put it in... |
|---|---|
| A new top-level screen (route) | `ui/screens/<NewScreen>.tsx` + register in `App.tsx` |
| A panel (mounted inside a screen, mostly UI logic) | `ui/panels/<feature>/...` |
| A composable visual brick used in 2+ panels | `ui/widgets/<brick>/...` |
| A pure visual primitive (chip, badge, button) | `ui/design/...` |
| A new design token (color, font weight, radius) | `ui/design/tokens.ts` |
| A new feature with its own state + hook + service | `features/<feature>/...` (mirror structure of `auth/` or `apps/`) |
| A new robot/session lifecycle method | Add it to `RobotSession` class in `features/robot-session/RobotSession.ts` |
| A new conversation orchestration step | Add it to the engine in `features/conversation/engine/conversation-engine.ts` (drives the session) |
| A pure helper used by 2+ features (Tauri plugin wrapper, browser API, etc.) | `shared/<area>/...` |
| A new env var reader | `shared/env.ts` (centralised so we can grep all `import.meta.env` usage in one place) |
| Static SVG / image | `src/assets/`, import via `@/assets/<file>.svg` |
| A test file | Co-locate next to the file under test (`X.ts` ↔ `X.test.ts`) |

## Conventions

### Imports

- **Use `@/` aliases for ANY cross-folder import.** Adopted because
  relative `../../../X` paths break on every file move; `@/` paths
  are stable.
- Same-folder relative imports (`./tokens`, `./Joystick`) are fine
  and idiomatic for intra-feature wiring.
- `tsc --noEmit` does NOT catch broken SVG/CSS/PNG paths. After a
  file move, grep for `from '\\.\\./` in the moved files and convert
  asset imports to `@/...`.

### Commits

Conventional Commits (`feat`, `fix`, `refactor`, `chore`, `docs`):

- `feat(<scope>):` for user-facing changes
- `fix(<scope>):` for bug fixes
- `refactor(<scope>):` for non-behavioural code reshuffling
- `chore(<scope>):` for tooling / build / config
- `docs:` for documentation

Scopes used in this repo: `session`, `engine`, `arch`, `apps`,
`auth`, `ble`, `wifi`, `ci`, `release`, `eslint`, etc.

### Validation cycle

After substantive changes:

```bash
yarn typecheck   # tsc --noEmit
yarn lint        # ESLint, includes layer rules
yarn test        # Vitest
```

The mobile dev loop:

```bash
yarn tauri:dev          # desktop preview (works on macOS/Linux/Windows)
yarn ios:dev            # iOS simulator + Xcode
yarn android:dev        # Android emulator
```

### Robot SSH access

The user has SSH on the Reachy Wi-Fi at `pollen@reachy-mini.local`
(pubkey already authorised). Use it proactively when debugging
daemon-side behaviour. See the rule
`.cursor/rules/robot-ssh-access.mdc` for usage etiquette and
useful commands.

## Companion docs

| File | What |
|------|------|
| `docs/APP_STORE_COMPLIANCE.md` | Apple / Google review policy framework + pre-submission action plan |
| `docs/APP_STORE_AUDIT_2026-05.md` | Submission-readiness gap analysis (what actually blocks a build today) |
| `docs/ANDROID_PERMISSIONS.md` | Runbook for iframe-delegated mic / camera / geolocation permissions on Android |
| `docs/APPS_TAB_REDESIGN.md` | Apps tab UX redesign + catalog payload shape |
| `docs/MCP_DESIGN.md` | Design draft for an MCP server wrapping the daemon |

## Notes for HF Space authors

Your HF Space loads as an iframe inside Reachy Mini Mobile. The host
delegates these capabilities to your iframe today: `microphone`, `camera`,
`geolocation`, `autoplay`, `clipboard-read`, `clipboard-write`. Use the
corresponding `navigator.*` API — nothing extra to request on your end.

> **Platform status today**: iOS is fully wired (Info.plist usage strings
> + iframe `allow` tokens). Android is not yet initialised as a Tauri
> target in this repo; the iframe tokens are already in place so the
> work that remains is OS-side. The full runbook lives in
> [`docs/ANDROID_PERMISSIONS.md`](./docs/ANDROID_PERMISSIONS.md):
> `tauri android init`, manifest patch, and a custom `WebChromeClient`
> in `MainActivity.kt` (Android WebView denies iframe `getUserMedia` /
> `getCurrentPosition` until the host implements
> `onPermissionRequest` + `onGeolocationPermissionsShowPrompt`).

### Don't gate on the permission prompt — ask, and if it works, go

In a regular browser, the first `getUserMedia` / `getCurrentPosition` call
shows a permission dialog and only proceeds once the user clicks Allow.
**Inside Reachy Mini, the dialog may never appear** — the mobile app
typically already holds the OS-level grant (e.g. from the built-in
conversation feature), so the iframe's call resolves silently. As a side
effect, `navigator.permissions.query({name:'microphone'})` returns
`'prompt'` inside the iframe even though capture works fine.

Spaces that gate their UI on a visible dialog (or on the Permissions API
returning `'granted'`) will look broken inside the app even though the
capability is fully available. The fix is purely Space-side: **call the
API and use whatever stream/position you get back. Don't condition UI on
`permissions.query` state, and don't expect a dialog every time.**

Diagnostic if your Space's mic / GPS feature works in a regular browser
but seems broken inside Reachy Mini: open Chrome `chrome://inspect/#devices`
on the dev machine, switch the DevTools console context to your
`*.hf.space` frame, and run:

```js
navigator.mediaDevices.getUserMedia({audio: true})
  .then(s => console.log('OK', s.getAudioTracks()))
  .catch(e => console.log('FAIL', e.name, e.message));
```

If it logs `OK`, capture works — the bug is in the Space's UI logic, not
the mobile host.

## Things to NOT do

- Don't put React components in `features/`. The layer rule blocks
  it; the goal is to keep the logic layer testable without React.
- Don't reach into `import.meta.env` directly outside `shared/env.ts`.
  Centralise env reads.
- Don't add a constant to `App.tsx` or `theme.ts` if it has a
  natural home in a feature.
- Don't bypass `@/` aliases with deep relatives. `'../../../foo'`
  is a smell that says "this should be `@/foo`".
- Don't merge UI primitives into `ui/widgets/` if they're consumed
  by only one panel. Keep it in the panel until a second consumer
  appears.
