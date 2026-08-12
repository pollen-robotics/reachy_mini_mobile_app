# Audio routing - 3-state design specification

Status: draft. Owner: `@tfrere`. Implementation lives in
`src/features/conversation/` and `src/features/conversation-settings/`.

This document is the single source of truth for the **3-state audio
routing** feature: letting the user choose where the conversation's
microphone and speaker live (the robot vs the phone).

**Read this before touching any of:**

- `src/features/conversation/engine/conversation-engine.ts`
- `src/features/conversation/engine/bridge/huggingface-bridge.ts`
- `src/features/conversation-settings/{store,storage,index}.ts`
- `src/ui/panels/conversation/ConversationSettingsPanel.tsx`

---

## 1. Context

### 1.1 Today's topology

The conversation is a pipeline between the robot and the HF realtime
backend, brokered by the phone. Audio is **fully on the robot**:

- **Mic input** = `robotMicTrack` (the robot's on-board mic, received on
  `robot._pc`) is passed as `inputTrack` to the realtime bridge.
- **Speaker output** = the assistant output track is routed via
  `routeOutputToRobot()` (`audioSender.replaceTrack(...)`) to the
  robot's speaker. A hidden, muted `<audio>` element keeps the inbound
  track decoding.

Echo cancellation (AEC) is provided by the robot's ReSpeaker hardware.
The phone's own microphone is opened by the SDK during `startSession()`
and then released (`releaseSdkPhoneMic`).

This is exactly **state 1** below; states 2 and 3 do not exist yet.

### 1.2 Why this is cheap to do

Input and output are already parameterised `MediaStreamTrack`s:
`realtimeBridge.connect(track)` takes the input track as an argument, and
`routeOutputToRobot()` is the single output-routing point. The 3 states
reduce to **two independent levers**.

---

## 2. The three states

| State | id | Mic source | Speaker sink | AEC | Robot moves |
|-------|----|------------|--------------|-----|-------------|
| 1. Reachy / Reachy | `robot-duplex` | robot mic track | robot speaker (`replaceTrack`) | robot-side / daemon (ReSpeaker XVF3800 HW) | yes |
| 2. Phone / Phone | `phone-duplex` | phone `getUserMedia` | phone `<audio>` (unmuted) | browser / OS WebRTC (free) | **no** |
| 3. Phone mic + Reachy speaker | `phone-mic-robot-speaker` | phone `getUserMedia` | robot speaker (`replaceTrack`) | **none** | yes |

```ts
type AudioRoute = "robot-duplex" | "phone-duplex" | "phone-mic-robot-speaker";

// resolved by the engine into two independent levers:
//   robot-duplex            -> { micSource: "robot", speakerSink: "robot" }
//   phone-duplex            -> { micSource: "phone", speakerSink: "phone" }
//   phone-mic-robot-speaker -> { micSource: "phone", speakerSink: "robot" }
```

Default: `"robot-duplex"` (current behaviour, no regression).

### 2.0 Where echo cancellation lives (per state)

AEC requires the canceller to know the **reference signal** (what the
speaker plays) so it can subtract it from the mic input. The owner of
that reference differs per state:

- **State 1 (`robot-duplex`) - robot-side / daemon.** The ReSpeaker
  XVF3800 board on the robot does hardware AEC: the mic and speaker are
  the same device, so the reference is local to the robot. The mobile
  app already tunes the board via `applyAudioStartupConfig(robot)` (the
  TS counterpart of the daemon's `apply_audio_startup_config`). Nothing
  to do in the browser - the AEC is entirely robot/daemon-owned.
- **State 2 (`phone-duplex`) - browser / OS WebRTC, for free.** The
  phone is **both** the capturing mic and the playing speaker (the
  `<audio>` sink), so the browser/OS WebRTC stack has the reference and
  cancels echo automatically - the exact same mechanism that makes phone
  video calls echo-free. We only need `echoCancellation: true` on the
  `getUserMedia` constraints. This is the same approach the web
  conversation app relies on for its "browser mode".
- **State 3 (`phone-mic-robot-speaker`) - nobody.** Mic and speaker are
  on **different** devices (phone vs robot), so neither canceller has
  the other side's reference. See § 2.1.

### 2.1 Why state 3 has no AEC (must warn the user)

The phone's AEC can only cancel what the **phone itself** plays. In
state 3 the robot is the one speaking, so the phone mic captures
Reachy's voice with no reference signal to subtract -> Reachy hears
itself and replies to itself. The ReSpeaker AEC is not in the loop
either (the mic comes from the phone). This is an inherent property of
the routing, not a bug: the UI **must** disclose it.

### 2.2 Embodiment invariant (state 2 = robot stays still)

> **The robot only animates when its own speaker is the voice output.**

```ts
const robotEmbodimentActive = speakerSink === "robot"; // states 1 and 3
```

In state 2 the voice comes out of the phone, so animating Reachy's head
as if it were talking would be a disembodied-puppet effect. Freezing it
makes state 2 a clean "phone / private" mode (voice in the phone
earpiece or headphones, Reachy connected but resting in its woken pose).

---

## 3. Design decisions (locked)

- **Switching policy: only while the conversation is stopped.** Mirrors
  the existing vision / memory toggles: the settings cog is already
  disabled during a live conversation, so the engine reads the route
  lazily at the next conversation start. **No live re-plumbing.**
- **UI location: a new "Audio" section in `ConversationSettingsPanel`**
  (the cog surface), consistent with vision / memory.
- **No 4th state.** Robot mic + phone speaker is excluded: same lack of
  AEC as state 3 with no added value.

---

## 4. Implementation plan

### Step 1 - Persistence + store (mirror vision/memory)

**`features/conversation-settings/storage.ts`**
- `AUDIO_ROUTE_KEY = 'reachyMini.conversationSettings.audioRoute'`.
- `readAudioRoute(): AudioRoute` (validate the read value, fallback to
  `"robot-duplex"`), `writeAudioRoute(value)`.

**`features/conversation-settings/store.ts`**
- `let audioRoute = readAudioRoute()`, engine getter `getAudioRoute()`,
  mutator `setAudioRoute()` (persist + `emit()`), hook `useAudioRoute()`
  via `useSyncExternalStore`.

**`features/conversation-settings/index.ts`**
- Re-export `getAudioRoute`, `setAudioRoute`, `useAudioRoute`, type
  `AudioRoute`.

### Step 2 - Phone microphone capture (lazy)

**New file `features/conversation/engine/capture-phone-mic.ts`**
- `capturePhoneMic({ echoCancellation }): Promise<{ track, stop }>`.
- `getUserMedia({ audio: { echoCancellation, noiseSuppression: true,
  autoGainControl: true, channelCount: 1 } })`.
  - `echoCancellation: true` for `phone-duplex` (effective).
  - `echoCancellation: false` for `phone-mic-robot-speaker` (useless;
    echo is assumed and disclosed in the UI).
- `stop()` ends the captured tracks (clean teardown).
- Reuse `unlockIosMicForWebRtc()` for the iOS unlock path.

> **Critical: capture lazily, release eagerly.** The phone mic must be
> opened **only** when the active route uses it (`phone-duplex` /
> `phone-mic-robot-speaker`) **and** only for the duration of a live
> conversation. It is never opened in `robot-duplex`, and it is stopped
> the moment the conversation ends. See § 5 for the full lifecycle and
> the privacy-indicator rationale.

### Step 3 - Bridge: parameterised output sink

**`bridge/huggingface-bridge.ts`**
- Add to the bridge deps: `speakerSink: () => "robot" | "phone"`
  (lazy getter, re-read on every `buildClient()`).
- Generalise `routeOutputToRobot(track)` into `routeOutput(track)`:
  - `"robot"` -> current behaviour (`replaceTrack` + muted sink).
  - `"phone"` -> **no** `replaceTrack`; set the `<audio>` sink
    `muted = false` (playback on the phone). The robot's sender keeps
    its default muted track, so Reachy stays silent.
- `onOutputTrack` still fires in all cases (the engine decides whether
  to wire motion - see Step 4).

### Step 4 - Engine: resolve the route at conversation start

**`conversation-engine.ts` -> `runConversationParts()`** (around the
`robotMicTrack` lookup, ~L909-923)
- Read `const route = getAudioRoute()` once. Derive `micSource`,
  `speakerSink`, `robotEmbodimentActive`.
- Resolve `inputTrack`:
  - `micSource === "robot"` -> `realtimeBridge.getRobotMicTrack(robot)`.
  - `micSource === "phone"` -> `await capturePhoneMic({ echoCancellation:
    route === "phone-duplex" })`.
- `audioMonitors.startMic(inputTrack)` on the resolved track (the orb
  reacts to the real source).
- Gate motion on `robotEmbodimentActive`:
  - call `motion.startSession()` only when `robotEmbodimentActive`.
  - in the `onStatus` handler, guard `motion.onListening/onUserSpeak/
    onProcessing/onAiSpeak` behind the same flag.
  - note for the phone-playback routes: the head wobble is produced by
    the daemon from the audio the *robot* receives, so it goes quiet on
    any route that plays the assistant on the phone instead. Face
    tracking still works (it's driven by the camera, not the audio).
    Restoring the wobble there would mean feeding the daemon
    `set_speech_offsets` from a phone-side analyser.
- `releaseSdkPhoneMic(robot)`: only when `micSource === "robot"` (phone
  modes keep our capture stream alive; the lit iOS mic indicator is then
  legitimate).

**`tearDownConversationPipeline`** (~L1367)
- Stop the captured phone-mic stream (its `stop()` handle) next to
  `audioMonitors.stopMic()`.

### Step 5 - UI: "Audio" section in the settings panel

**`ConversationSettingsPanel.tsx`**
- New `<Section label="Audio">` with a 3-option selector (same chip /
  Card treatment as the language row), driven by `useAudioRoute()` /
  `setAudioRoute()`.
- Per option: icon + short label ("Reachy", "Phone", "Phone mic +
  Reachy").
- When state 3 is selected, show a warning line (e.g. `warning.main`):
  "No echo cancellation - Reachy may hear itself talk."
- No new guard needed: the cog is already disabled during a live
  conversation.

### Step 6 - Tests + validation

- Unit test for store/storage (round-trip + invalid-value fallback),
  in the style of existing tests.
- Engine/`RobotSession.test.ts`: assert `robot-duplex` stays the
  unchanged default path.
- **Real-device validation required for states 2 and 3** (see § 6 for
  the per-platform matrix): iOS `PlayAndRecord` audio-session behaviour
  and Android continuous-capture permission path are the only genuine
  unknowns.

---

## 5. Microphone capture lifecycle (lazy acquire, eager release)

The whole point of a 3-state design is that the phone mic is a **scarce,
privacy-sensitive resource**. Holding `getUserMedia({audio})` lights the
iOS orange status-bar indicator and the Android mic indicator (Android
12+), and on iOS keeps the audio session in a recording category. We
must never hold it longer than strictly necessary.

### 5.1 Rules

1. **Never capture in `robot-duplex`.** The robot's on-board mic is the
   only source; the phone mic is not touched at all (today's behaviour,
   unchanged).
2. **Capture only on conversation start, only for phone-mic routes.**
   `capturePhoneMic()` runs inside `runConversationParts()` and only
   when `micSource === "phone"`. It is never called speculatively (not
   on app launch, not on tab switch, not while parked in `ready`).
3. **Release on every exit path.** `stop()` the captured stream in
   `tearDownConversationPipeline()` (covers user stop, fatal error,
   power-off, unmount, transparent-reconnect teardown). After release
   the OS indicator must go dark.
4. **Route change implies stop + restart.** Because switching is only
   allowed while stopped (§ 3), a change from a phone-mic route to
   `robot-duplex` naturally releases the mic at the next start; there is
   no live hand-off to reason about.
5. **`releaseSdkPhoneMic` stays robot-only.** In `robot-duplex` we keep
   calling it (the SDK's transient `_micStream` must be released). In
   phone-mic routes we do **not** call it - our own capture stream is
   the legitimate live mic, and the lit indicator is correct.

### 5.2 The pre-flight `unlockIosMicForWebRtc()` is unchanged

`unlockIosMicForWebRtc()` already grabs `getUserMedia({audio:true})`
once at connect time and **immediately stops the tracks** (it only
exists to unlock iOS LAN ICE candidates / trigger the Android prompt).
That transient grab is orthogonal to this feature and stays as-is. Our
new capture is a *separate*, longer-lived stream owned by
`capture-phone-mic.ts` and governed by the rules above.

---

## 6. Platform coverage (iOS + Android)

This feature targets **both** iOS and Android. The JS/TS layer is
platform-agnostic (same `getUserMedia` + `<audio>` element). The
platform-specific work is native and differs sharply.

| Concern | iOS (WKWebView) | Android (Tauri/wry WebView) |
|---------|-----------------|------------------------------|
| Phone-mic permission prompt | WKWebView prompts on first `getUserMedia`; `NSMicrophoneUsageDescription` already declared | Requires `RECORD_AUDIO` in the manifest **and** a `WebChromeClient.onPermissionRequest` bridge - see `docs/ANDROID_PERMISSIONS.md` § 5 |
| Continuous capture (states 2/3) | Works once granted | **Depends on the Android permission bridge being wired** (currently pre-Android-target) |
| Play on phone + capture (state 2) | Needs `PlayAndRecord` audio-session category; validate the `<audio>` element actually outputs while the mic is live | Validate the WebView plays the assistant track while holding `RECORD_AUDIO` |
| Privacy indicator | Orange dot while our capture stream is live (expected in states 2/3, must clear on stop) | Mic indicator (Android 12+); same expectation |
| Background audio | `UIBackgroundModes = audio` already set | Foreground-service decision is deferred (`ANDROID_PERMISSIONS.md` § 6) - background behaviour for phone-mic modes inherits that decision |

### 6.1 Implications

- **iOS is the near-term shippable target** (TestFlight). The main
  validation is the `PlayAndRecord` session behaviour for state 2.
- **Android continuous phone-mic capture is gated on the
  `WebChromeClient` permission bridge** from `ANDROID_PERMISSIONS.md`
  § 5, which is not yet implemented. Until then, states 2/3 may prompt
  but fail to capture on Android. Treat that native bridge as a
  prerequisite for the Android rollout of states 2/3 (state 1 is
  unaffected and already works on both).
- Use `isMobilePlatform()` / `getPlatform()` (`src/shared/platform.ts`)
  if any branch needs to degrade gracefully on desktop/browser dev
  (where `getUserMedia` is shimmed off in `desktop-mic-shim.ts`).

### 6.2 Validation matrix

- [ ] **iOS**: states 2 + 3 capture from the phone mic; state 2 plays
      assistant audio through the phone speaker; orange indicator clears on
      stop; state 1 unchanged.
- [ ] **Android**: same path once the `WebChromeClient` bridge is wired;
      mic indicator clears on stop.
- [ ] **Both**: switching route while stopped, then starting, picks up
      the new route; no mic held while parked in `ready`.

---

## 7. Files touched

| File | Nature |
|------|--------|
| `conversation-settings/storage.ts` | +~15 lines |
| `conversation-settings/store.ts` | +~25 lines |
| `conversation-settings/index.ts` | re-exports |
| `conversation/engine/capture-phone-mic.ts` | **new**, lazy capture + `stop()`, ~45 lines |
| `bridge/huggingface-bridge.ts` | parameterised sink, ~35 lines |
| `conversation-engine.ts` | route selection + motion gating + lazy capture + eager release, ~55 lines |
| `ConversationSettingsPanel.tsx` | "Audio" section, ~90 lines |

Total: ~250-300 lines of JS/TS, medium effort, no refactor.

**Android native prerequisite (separate work):** the `WebChromeClient`
permission bridge from `docs/ANDROID_PERMISSIONS.md` § 5 must be wired
for states 2/3 to capture on Android. Not counted in the line estimate
above; tracked as a prerequisite for the Android rollout (§ 6.1).

---

## 8. Out of scope

- 4th combination (robot mic + phone speaker): excluded by design.
- Live route switching: deferred (switch-while-stopped only).
