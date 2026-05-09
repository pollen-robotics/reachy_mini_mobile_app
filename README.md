# Reachy Mini Mobile

Cross-platform Tauri 2 app (iOS / Android / desktop) for **Reachy Mini**.
Sign in with Hugging Face, pick one of your robots, and:

- **Talk to it** with a real-time voice conversation (OpenAI Realtime API,
  in-app orb panel - no more iframe).
- **Browse and launch apps** from the Hugging Face Hub catalog (each app
  runs in a sandboxed iframe with the robot handed off seamlessly).
- **Drive the head manually** with a virtual joystick + monitor camera +
  adjust speaker / microphone volume from a dedicated Robot tab.
- **Bootstrap a fresh robot's Wi-Fi** over Bluetooth (PIN exchange,
  network credentials, daemon health probe).

## Status

`v0.3.x` - the app is shippable. iOS + Android CI builds run on every tag,
and we sideload internal-tester IPAs / APKs through the GitHub Actions
workflow (`.github/workflows/build-mobile.yml`). Desktop dev builds work
out of the box on macOS / Linux / Windows.

## Stack

| Concern | Choice | Why |
|---|---|---|
| App shell | Tauri 2 | iOS + Android + desktop from one codebase |
| Frontend | Vite 7 + React 19 + TypeScript + SWC | Fast dev loop, modern toolchain |
| UI kit | MUI v7 + Emotion | Battle-tested on mobile WebViews |
| Async state | TanStack Query v5 | Apps catalog + central robots fetching |
| BLE | [`tauri-plugin-blec`](https://github.com/MnlPhlp/tauri-plugin-blec) (`@mnlphlp/plugin-blec`) | iOS + Android, based on `btleplug` |
| WebRTC + AI | OpenAI Realtime API direct WebRTC | No backend, browser-side handshake |
| Robot signaling | Hugging Face central Space (`pollen-robotics-reachy-mini-central.hf.space`) | Producer-consumer relay over WebSocket |
| Tests | Vitest | Pure logic + parsing tests |

## What's inside (architecture in 30 seconds)

The codebase is split into two pillars:

```
src/
├── ui/         All React UI: design system, widgets, panels, screens
└── features/   All non-UI logic: auth, ble, wifi, apps, robot-session, conversation
```

The two key features:

- **`features/robot-session/`** owns everything WebRTC + physical robot:
  the `RobotSession` class wraps the SDK with retry-aware bring-up
  (`start`), wake/sleep trajectories (`wakeUp`, `sleepAndDisable`),
  iframe-handoff release/reacquire, video stream caching, transport +
  data-channel health monitoring.
- **`features/conversation/`** owns the OpenAI Realtime conversation:
  the engine drives a `RobotSession` plus the audio bridge, motion
  controllers (head wobbler, antennas), tool-call dispatch, and the
  long-term memory store.

The architecture is enforced by ESLint rules (`no-restricted-imports`)
so layers can't accidentally cross-depend.

**Read [`AGENTS.md`](./AGENTS.md) before contributing** - it covers the
folder structure, the import conventions, the layer rules, and a
"where do I put X?" cheat sheet.

For the deep specs:
- [`docs/CONNECTION_FLOW.md`](./docs/CONNECTION_FLOW.md) - end-to-end
  auth + discovery + session lifecycle
- [`docs/VISION.md`](./docs/VISION.md) - design for a future
  scene-awareness module (VLM)
- [`docs/MCP_DESIGN.md`](./docs/MCP_DESIGN.md) - design draft for an MCP
  server wrapping the daemon
- [`docs/WEBRTC_LOGS.md`](./docs/WEBRTC_LOGS.md) - PR plan for streaming
  daemon journalctl over WebRTC

## Setup

### Prerequisites

- Node.js 20+ (24 LTS recommended)
- Yarn 1.x
- Rust stable with `cargo`
- Xcode 15+ (for iOS)
- Android Studio + NDK (for Android)

Follow the [Tauri 2 mobile prerequisites](https://v2.tauri.app/start/prerequisites/)
for your platform.

### Environment variables

Copy `.env.example` to `.env.local` and fill in:

```env
# OpenAI Realtime API key (required for the in-app voice conversation).
# ⚠️ TEMPORARY: baked into the bundle at build time, extractable from
# the .ipa / .apk - debug / internal-tester only. See AGENTS.md for the
# proper-arch TODO.
VITE_OPENAI_API_KEY=sk-proj-...

# Optional: override the central signaling Space for staging.
# Defaults to the production pollen-robotics instance.
# VITE_REACHY_CENTRAL_URL=https://my-staging-central.hf.space
```

### Install

```bash
yarn install
```

## Development

### Desktop

Works on macOS / Linux / Windows from day one:

```bash
yarn tauri:dev
```

### iOS

First-time setup (once per workspace):

```bash
yarn tauri ios init
```

Then:

```bash
yarn ios:dev
```

The first run launches Xcode. You'll need to:

1. Confirm `NSBluetoothAlwaysUsageDescription` is in
   `src-tauri/gen/apple/<app>_iOS/Info.plist` (CI patches this
   automatically; for local dev it's already in the repo).
2. Add the **CoreBluetooth.framework** under *Project → General →
   Frameworks, Libraries, and Embedded Content*.
3. Select a signing team (personal or organization).

### Android

```bash
yarn tauri android init   # once
yarn android:dev
```

Required permissions in `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```

## Validation

```bash
yarn typecheck   # tsc --noEmit (strict)
yarn lint        # ESLint, includes architectural layer rules
yarn test        # Vitest
```

The `lint` step enforces the layer rules from `AGENTS.md` via
`no-restricted-imports` (e.g. `features/` cannot import from `ui/`).

## CI / release

GitHub Actions builds iOS + Android tester bundles on every tag push.
See `.github/workflows/build-mobile.yml` for the matrix. The workflow
injects the OpenAI API key into the bundle from a repo secret
(`OPENAI_API_KEY`) - same temporary mechanism as local dev, marked for
replacement in `AGENTS.md`.

## License

Apache 2.0 - see [`LICENSE`](./LICENSE).
