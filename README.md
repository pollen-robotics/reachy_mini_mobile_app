# Reachy Mini Mobile

Cross-platform Tauri 2 app (iOS / Android / desktop) for **Reachy Mini**.
Sign in with Hugging Face, pick one of your robots, and:

- **Talk to it** with a real-time voice conversation (OpenAI Realtime API,
  in-app orb panel - no more iframe).
- **Browse and launch apps** from the Hugging Face Hub catalog (each app
  runs in a sandboxed iframe with the robot handed off seamlessly).
- **Drive the head manually** with a virtual joystick + monitor camera +
  adjust speaker / microphone volume from a dedicated Robot tab.

The robot is expected to be already provisioned (on Wi-Fi, advertising
itself on the HF central signaling Space). First-time Wi-Fi setup is
handled outside this app.

## Status

`v0.6.x` - the app is shippable. Every `v*` tag push runs the full
`.github/workflows/build-mobile.yml` pipeline: unsigned simulator
`.app` + unsigned debug `.apk` (attached to the GitHub release), plus
the signed TestFlight upload (iOS) and the signed Play Internal upload
(Android). Desktop dev builds work out of the box on macOS / Linux /
Windows. See [CI / release](#ci--release) for the cut-a-release
procedure.

## Stack

| Concern | Choice | Why |
|---|---|---|
| App shell | Tauri 2 | iOS + Android + desktop from one codebase |
| Frontend | Vite 7 + React 19 + TypeScript + SWC | Fast dev loop, modern toolchain |
| UI kit | MUI v9 + Emotion | Battle-tested on mobile WebViews |
| Async state | TanStack Query v5 | Apps catalog + central robots fetching |
| WebRTC + AI | OpenAI Realtime API direct WebRTC | No backend, browser-side handshake |
| Robot signaling | Hugging Face central Space (`pollen-robotics-reachy-mini-central.hf.space`) | Producer-consumer relay over WebSocket |
| Tests | Vitest | Pure logic + parsing tests |

## What's inside (architecture in 30 seconds)

The codebase is split into two pillars:

```
src/
├── ui/         All React UI: design system, widgets, panels, screens
└── features/   All non-UI logic: auth, apps, robot-session, conversation
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
- [`docs/MCP_DESIGN.md`](./docs/MCP_DESIGN.md) - design draft for an MCP
  server wrapping the daemon
- [`docs/APP_STORE_COMPLIANCE.md`](./docs/APP_STORE_COMPLIANCE.md) -
  Apple / Google review checklist
- [`docs/APP_STORE_AUDIT_2026-05.md`](./docs/APP_STORE_AUDIT_2026-05.md) -
  submission-readiness gap analysis (what blocks a build today)
- [`docs/ANDROID_PERMISSIONS.md`](./docs/ANDROID_PERMISSIONS.md) -
  runbook for iframe-delegated mic/camera/geolocation permissions on Android

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

The mobile bundle no longer ships with a long-lived OpenAI API
key. Voice conversation works out of the box against the
production website Space (`pollen-robotics-reachy-mini.hf.space`),
which mints per-user OpenAI Realtime ephemeral keys via
`/api/openai/ephemeral` once the user is signed in to Hugging Face.

Copy `.env.example` to `.env.local` only if you need to override
defaults (staging signaling or staging website host):

```env
# Optional: override the HF central signaling Space for staging.
# Defaults to the production pollen-robotics instance.
# VITE_REACHY_CENTRAL_URL=https://my-staging-central.hf.space

# Optional: override the Reachy Mini website host (mint endpoint).
# Defaults to the production pollen-robotics website Space.
# VITE_REACHY_WEBSITE_URL=https://my-staging-website.hf.space
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

The first run launches Xcode. You'll need to select a signing team
(personal or organization) before the build can sign the app for the
simulator / device.

### Android

```bash
yarn tauri android init   # once
yarn android:dev
```

Lock the activity to portrait so the orb / column layout doesn't get
crushed in landscape, mirroring the iOS `UISupportedInterfaceOrientations`
in `Info.plist`. On the `<activity>` tag inside `AndroidManifest.xml`:

```xml
<activity
    ...
    android:screenOrientation="portrait"
    android:configChanges="orientation|screenSize|keyboardHidden|uiMode">
```

Android 15+ enforces edge-to-edge on `targetSdk >= 35` apps, so the
WebView automatically extends behind the system bars. Our screens
already read `env(safe-area-inset-top/bottom)` to keep their content
out of the OS chrome; the `viewport-fit=cover` meta tag in
`index.html` is what makes those values non-zero. Verify the values
on a real Android 15 device after `tauri android init` if anything
looks off (the wry version pinned in `Cargo.toml` matters here).

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
See `.github/workflows/build-mobile.yml` for the matrix and the
secrets list (Apple TestFlight, Play Console service account, signing
certs). The workflow no longer needs an `OPENAI_API_KEY` repo secret:
voice conversation goes through the website Space's
`/api/openai/ephemeral` mint endpoint at runtime, so the bundle ships
without any OpenAI credential.

### Cut a release

Versioning is loose semver:

- patch (`0.6.4 -> 0.6.5`) for polish, dev-only fixes, internal
  refactors, dependency bumps that don't change user-facing behavior
- minor (`0.5.6 -> 0.6.0`) when there's a real new user-facing
  feature (passive vision, language picker, etc.) or a new platform
  target (Android CI, BLE setup flow, ...)

The user-facing build number (`CFBundleShortVersionString` on iOS,
`versionName` on Android) is read from two files that must stay in
lockstep:

- `package.json` -> `version`
- `src-tauri/tauri.conf.json` -> `version`

(`src-tauri/Cargo.toml` carries a separate crate version that the
build never surfaces to end users; leave it alone.)

The build *number* (`CFBundleVersion`, `versionCode`) is auto-derived
from `${{ github.run_number }}` in CI so each tag push gets a fresh,
monotonically increasing build number even when re-tagging the same
marketing version.

Release procedure:

```bash
# Stand on a clean, fully-rebased main.
git checkout main && git pull --ff-only

# Bump both files in lockstep. v0.6.5 used as the example below.
sed -i '' 's/"version": "0\.6\.4"/"version": "0.6.5"/' package.json
sed -i '' 's/"version": "0\.6\.4"/"version": "0.6.5"/' src-tauri/tauri.conf.json

git add package.json src-tauri/tauri.conf.json
git commit -m "chore(release): bump version to 0.6.5"

# Tag + push (commit first, then tag - `build-mobile.yml` only
# triggers on the tag, so the bump commit must be on origin when the
# CI runner checks out the tag).
git push origin main
git tag v0.6.5
git push origin v0.6.5
```

What runs on a `v*` tag push:

- `ios` (macOS): unsigned iOS Simulator `.app`, attached to the
  GitHub release. ~10-15 min.
- `android` (Ubuntu): unsigned debug `.apk`, attached to the GitHub
  release. ~15-20 min.
- `ios-release` (macOS): signed device IPA, validated with `altool`
  and uploaded to App Store Connect's TestFlight Activity tab.
  ~25-35 min. Apple's own processing then adds another 5-15 min
  before the build becomes installable to testers.
- `android-release` (Ubuntu): signed APK + AAB, uploaded to Play
  Console's Internal testing track. ~20-30 min. While the Play
  listing is still in *draft* state, the upload lands as a draft
  release you must roll out manually under
  *Internal testing → Review release → Roll out to internal testing*.
- `attach-to-release` (Ubuntu): creates the GitHub release if
  missing (auto-generated notes from the previous tag) and uploads
  the simulator `.app.zip` + debug `.apk` to it.

Mistakes happen. If you push the tag against the wrong commit
(e.g. before pushing the bump), delete it before retrying:

```bash
git push --delete origin v0.6.5
git tag -d v0.6.5
# fix what needs fixing, then re-tag + re-push
```

Re-pushing the same tag is safe per CI (`cancel-in-progress: true`
in the workflow's concurrency group), but it does increment
`github.run_number` on each run, so the new build number is always
higher than the previous attempt - Play / App Store Connect won't
reject the second upload for duplicate `versionCode` / `CFBundleVersion`.

## License

Apache 2.0 - see [`LICENSE`](./LICENSE).
