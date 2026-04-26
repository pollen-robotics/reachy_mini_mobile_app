# Reachy Mini Mobile

Minimal cross-platform Tauri client for Reachy Mini. Designed to:

1. Discover a Reachy Mini nearby via **Bluetooth Low Energy**.
2. Read its network status (mode + IPv4) from the daemon's BLE characteristic.
3. Check the phone and the robot are on the same `/24` subnet.
4. Probe `/api/daemon/status` on the robot over HTTP (via a native Rust proxy).
5. Open the [conversation HF Space](https://huggingface.co/spaces/tfrere/reachy-mini-minimal-js-conversation-app) in an iframe.

It is a **client only**: the daemon runs on the robot, never on the phone. No
sidecar, no Python, no auto-updater. All of the lifecycle complexity that
lives in the desktop app has been removed on purpose.

> **Status**: POC / v0. iOS + Android first, desktop builds should work from
> day one thanks to Tauri 2's unified targets.

## Stack

| Concern | Choice | Why |
|---|---|---|
| App shell | Tauri 2 | iOS + Android + desktop from one codebase |
| Frontend | Vite + React 19 + TS + SWC | Same family as the desktop app, fast dev loop |
| UI kit | MUI v7 + Emotion | Matches the desktop app, battle-tested on mobile WebViews |
| State | Zustand | Lightweight, trivially migrates to/from the desktop store |
| BLE | [`tauri-plugin-blec`](https://github.com/MnlPhlp/tauri-plugin-blec) (+ `@mnlphlp/plugin-blec`) | Supports iOS + Android, based on `btleplug` |
| HTTP to daemon | Native `reqwest` via Tauri command | Bypasses mobile WebView mixed-content blocking |

## Architecture

### Three screens, one flow

```
  ┌──────────────┐       ┌────────────────┐       ┌──────────────────────┐
  │  ScanScreen  │ tap → │ DashboardScreen│ tap → │ ConversationScreen   │
  │  (BLE scan)  │       │ (IP + health)  │       │ (iframe HF Space)    │
  └──────────────┘       └────────────────┘       └──────────────────────┘
         ▲                     │   ▲                         │
         └─────────── back ────┘   └──────── back ───────────┘
```

### Data flow

```
    BLE                           HTTP (via Rust)            iframe
 ┌──────┐        scan + read     ┌───────────┐              ┌───────────────┐
 │phone │  ────────────────────▶ │ daemon    │              │ HF Space      │
 │      │  ◀──── NETWORK_STATUS  │ :8000     │              │ (HTTPS, OAuth │
 └──────┘        "[wlan0] ip"    └───────────┘              │  + WebRTC)    │
                                                            └───────┬───────┘
                                                                    │
                                                                    ▼
                                                         HF-hosted signaling
                                                         server, rendezvous
                                                         with the robot
```

The conversation iframe does **not** talk to the daemon in HTTP: the
conversation app uses a HF-hosted WebRTC signaling server, which both the
phone and the robot connect to. That is why we can serve the iframe from
HTTPS (`https://huggingface.co/...`) without running into mixed-content or
microphone permission issues.

### Key design decisions

- **No `fetch()` to `http://` from the frontend.** Mobile WebViews block
  plain-HTTP calls from our HTTPS-origin page. Everything goes through the
  Rust `daemon_fetch` command (`src-tauri/src/commands.rs`), which uses
  `reqwest`. Single place to reason about timeouts, headers, and TLS later.
- **No custom URI scheme in v0.** The conversation iframe is already HTTPS
  (HF Space). If we ever want to iframe a *daemon-hosted* app (needed to
  bypass HTTPS + get microphone in a secure context), we will add a
  `reachy://` scheme at that point and not before.
- **No `/api/state/ws/full` in v0.** The viewer3D / audio bars / log
  console from the desktop app would make the POC heavier by 3-5 kLOC.
  Scope-locked to a pure shell for now; porting those components is
  tracked separately.
- **BLE-first discovery, not mDNS.** Bluetooth gives us a reliable, user-
  visible "the robot is right here" signal *and* tells us whether the
  phone and the robot share a subnet before any HTTP call. mDNS stays an
  option for a later iteration when users ask for contactless discovery.
- **Subnet check is /24-only.** Works for every realistic home WiFi and
  for the robot's built-in hotspot. CIDR math can be added if someone runs
  in a weirder network, but it's unneeded complexity today.

### Code layout

```
src/
├── App.tsx               # Root + screen router (plain state machine)
├── main.tsx              # Vite entry, MUI theme binding
├── theme.ts              # Light + dark MUI themes
├── config.ts             # Single place for URLs, timeouts, BLE prefix
├── store/
│   └── useRobotStore.ts  # Zustand store (connection, discovered, network)
├── types/
│   └── robot.ts          # Shared types used by every screen
├── ble/
│   ├── constants.ts      # Service + char UUIDs (mirrors daemon)
│   ├── parseNetworkStatus.ts
│   └── useBle.ts         # scan / connect / readNetworkStatus / disconnect
├── daemon/
│   ├── daemonFetch.ts    # Typed wrapper over the Rust command
│   └── useDaemonStatus.ts# Probe /api/daemon/status with optional polling
├── network/
│   ├── sameSubnet.ts     # /24 comparison helpers
│   └── useLocalIps.ts    # Pulls phone IPs from Rust on mount
├── screens/
│   ├── ScanScreen.tsx
│   ├── DashboardScreen.tsx
│   └── ConversationScreen.tsx
└── components/
    ├── RobotListItem.tsx
    ├── StatusBadge.tsx
    ├── ErrorBanner.tsx
    └── NetworkMismatchPanel.tsx

src-tauri/
├── Cargo.toml
├── tauri.conf.json
├── capabilities/default.json
├── build.rs
└── src/
    ├── main.rs           # Thin entrypoint
    ├── lib.rs            # Tauri builder, plugin registration
    └── commands.rs       # daemon_fetch + local_ips
```

## Setup

### Prerequisites

- Node.js 20+ (24 LTS recommended)
- Yarn (or npm)
- Rust 1.77+ with `cargo`
- Xcode 15+ (for iOS)
- Android Studio + NDK (for Android)

Follow the [Tauri 2 mobile prerequisites](https://v2.tauri.app/start/prerequisites/)
for your platform.

### Install

```bash
yarn install
```

### Desktop dev

Works from day one on macOS / Linux / Windows:

```bash
yarn tauri:dev
```

### iOS dev

First-time setup (once per workspace):

```bash
yarn tauri ios init
```

Then:

```bash
yarn ios:dev
```

The first `--open` run launches Xcode. You will need to:

1. Add `NSBluetoothAlwaysUsageDescription` to `src-tauri/gen/apple/<app>_iOS/Info.plist`
   (the Bluetooth plugin relies on this).
2. Add the **CoreBluetooth.framework** under *Project → General → Frameworks,
   Libraries, and Embedded Content*.
3. Select a signing team (personal or organization).

### Android dev

```bash
yarn tauri android init   # once
yarn android:dev
```

`AndroidManifest.xml` will need:

```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```

(The Tauri plugin handles the rest on newer Android versions.)

## What is intentionally **not** here

The following features from the desktop app were deferred:

- 3D URDF viewer / X-ray / scan effects
- Audio level bars + DoA indicator
- Log console (daemon + frontend + app logs)
- Application store (install / start / stop apps)
- Camera WebRTC feed
- Auto-updater
- USB detection
- First-time WiFi setup wizard
- Robot commands (head pose, expressions, choreographies)

Each of these has well-defined entry points in the desktop codebase and
can be ported incrementally. The goal of v0 is to lock down the
connection-and-iframe flow before touching any of them.

## License

Apache 2.0 (matching the parent Reachy Mini repos).
