/**
 * Reachy Mini · voice conversation engine.
 *
 * This file is the orchestrator for the CONVERSATION feature. It owns
 * the FSM and the conversation pipeline (OpenAI Realtime, motion,
 * tools, audio monitors) and drives a `RobotSession` instance for
 * everything session-related (SDK boot, WebRTC handshake, wake/sleep
 * trajectories, release/reacquire for iframe handoffs).
 *
 * Flow driven by a single central circle button:
 *
 *   signed-out  → click → robot.login()  (HF OAuth redirect)
 *   authenticated → click → session.ensureConnected() / robot.connect()
 *   connected  → select a robot ⇒ ready
 *   ready      → click → session.start() + session.wakeUp() +
 *                        OpenAI Realtime WebRTC
 *   streaming  (listening / user-speaking / ai-speaking)
 *
 * Audio routing (robot = hub):
 *   robot mic track (received on robot._pc) ─▶ OpenAI input track
 *   OpenAI output track                     ─▶ robot audio sender (replaceTrack)
 *
 * Layered architecture
 * ────────────────────
 *
 *   features/robot-session/    ← SESSION layer (B + C in the
 *                                A/B/C/D model).
 *
 *     RobotSession.ts          The class. Owns the SDK robot ref,
 *                              selectedRobotId, knownRobots, the
 *                              `established` flag and the motor-mode
 *                              dedup cache. Exposes lifecycle methods
 *                              (start, wakeUp, sleepAndDisable, stop,
 *                              disconnect, ensureConnected, release,
 *                              reacquire, attachVideo) that wrap the
 *                              SDK + the helpers below with the right
 *                              preconditions and bookkeeping.
 *     start-session.ts         Per-attempt timeout + libnice retry
 *                              loop used by `session.start()` /
 *                              `session.reacquire()`.
 *     physical.ts              `wakeRobot` / `sleepAndDisableRobot`
 *                              with hard JS timeouts on top of the
 *                              SDK's own `timeoutMs`.
 *     session-guard.ts         Stop-intent counter (`expectedStop`).
 *     video-cache.ts           Cached `MediaStream` for late attachers.
 *     transport-monitor.ts     ICE candidate pair classifier.
 *     dc-health.ts             Data-channel failure streak monitor.
 *     background-resilience.ts visibility / audio-context resume.
 *     sdk-bootstrap.ts         Side-effect import of the vendored SDK.
 *     sdk-types.ts             `ReachyMiniInstance` shape.
 *     token-hash.ts            `#hf_token` URL-fragment plumbing.
 *     lifecycle-queue.ts       Module-level mount/unmount serialiser.
 *     phase.ts                 React-side phase derivation.
 *     useRobotSession.ts       React hook wrapper.
 *
 *   features/conversation/engine/  ← CONVERSATION layer (D).
 *
 *     conversation-engine.ts   ← THIS FILE. FSM, mount lifecycle,
 *                              boot pipeline (doConnect / doStart /
 *                              runConversationParts), teardown
 *                              orchestration, composes everything
 *                              below.
 *     types.ts                 Public types (Handle, AppState, …).
 *     settings.ts              OpenAI / voice user preferences.
 *     memory.ts                Long-term memory (`remember` tool).
 *     audioLevelMonitor.ts     `MicLevelMonitor` + `AiLevelMonitor`
 *                              classes driving the orb visuals.
 *     audio-monitors-control.ts Engine-side wrapper over the two
 *                              monitor classes: lazy instantiation,
 *                              cached mic level, `waitForAiSilence`
 *                              fallback, audio-context resume.
 *     release-sdk-phone-mic.ts Releases the iOS phone-mic claim
 *                              after the OpenAI bridge has swapped
 *                              the WebRTC sender's track.
 *     robot-events.ts          SDK `addEventListener` wiring
 *                              (probes, robotsChanged, sessionStopped,
 *                              videoTrack, disconnected, error).
 *     host-handle.ts           `ConversationEngineHandle` factory:
 *                              every method the React host calls
 *                              (lifecycle, volume, joystick, …).
 *     trajectoryGate.ts        Daemon-trajectory yield flag.
 *     tools.ts                 OpenAI tool descriptors + head poses.
 *
 *     bridge/openai-bridge.ts  OpenAI Realtime client lifecycle:
 *                              SDP handshake, audio sink, output
 *                              track routing to the robot speaker,
 *                              silent one-shot reconnect.
 *
 *     motion-control/
 *       wobbler-control.ts     `HeadWobbler` lifecycle + gates.
 *       antennas-control.ts    `AntennasOscillator` lifecycle.
 *       pose-dispatcher.ts     30 Hz coalescing tick to the daemon.
 *
 *     tools/
 *       tool-call-handler.ts   OpenAI tool dispatch (move_head,
 *                              play_move, remember, forget) + lazy
 *                              `MovePlayer` + pose-restore timer.
 */

// Side-effect import: attaches the bundled SDK to `window.ReachyMini`
// and dispatches `reachymini:ready` so the engine's CDN-style waiter
// (`whenReachyReady()`) resolves immediately. Without this the engine
// sits forever in `connecting`, waiting for a global that no <script>
// tag will ever set in the bundled mobile build.
import "@/features/robot-session/sdk-bootstrap";

import type { ReachyMiniInstance, RobotInfo } from "@/features/robot-session/sdk-types";
import { CENTRAL_SIGNALING_URL } from "@/shared/env";
import { unlockIosMicForWebRtc } from "../permissions/iosMicUnlock";
import {
  createBackgroundAudioKeeper,
  type BackgroundAudioKeeper,
} from "../background-audio-keeper";
import { applyAudioStartupConfig } from "./audio-startup-config";
import { createAudioMonitorsControl } from "./audio-monitors-control";
import { consumeTokenFromHash, whenReachyReady } from "@/features/robot-session/token-hash";
import { loadSettings, type Settings } from "./settings";
import {
  EphemeralKeyError,
  mintEphemeralKey,
  readHfTokenFromStorage,
} from "./ephemeral-key";
import { memoryStore } from "./memory";
import { getActivePersonality } from "@/features/personalities";
import { createDcHealthMonitor } from "@/features/robot-session/dc-health";
import { installBackgroundResilience } from "@/features/robot-session/background-resilience";
import { RobotSession } from "@/features/robot-session/RobotSession";
import { createToolCallHandler } from "./tools/tool-call-handler";
import { createMotionOrchestrator } from "./motion-control/orchestrator";
import { createOpenaiBridge } from "./bridge/openai-bridge";
import { attachVision, getVisionPromptAppendix, type VisionHandle } from "../vision";
import {
  getActiveLanguageId,
  getLanguagePromptAppendix,
} from "../../conversation-language";
import { isMemoryEnabled, isVisionEnabled } from "../../conversation-settings";
import { ROBOT_TOOLS } from "./tools";
import { releaseSdkPhoneMic } from "./release-sdk-phone-mic";
import { wireRobotEvents } from "./robot-events";
import { createConversationHandle } from "./host-handle";
import { createEngineCore } from "./engine-core";
import type {
  AppState,
  ConversationConnectionAttempt,
  ConversationEngineHandle,
  ConversationEngineOptions,
  ConversationToolToastEvent,
  ConversationTransportInfo,
} from "./types";

// Public-types re-exports so the prior import path keeps working.
// New code should pull these straight from `./types`.
export type {
  AppState,
  ConversationConnectionAttempt,
  ConversationEngineHandle,
  ConversationEngineOptions,
  ConversationLevelEvent,
  ConversationState,
  ConversationToolToastEvent,
  ConversationTransportInfo,
  ConversationTransportKind,
} from "./types";

/**
 * Bootstrap the conversation engine inside `root` (a mounted DOM node
 * rendered by React with the same structure as the original Space's
 * `index.html`). Returns an object with an async `unmount()` used by
 * the React component on cleanup.
 */
export function mountConversation(
  root: HTMLElement,
  options: ConversationEngineOptions = {},
): ConversationEngineHandle {
// Captured in the closure so all the state-machine functions below
// can check whether we're on the mobile "fast path". Null means "act
// like the public Space app" (tap-to-connect, wait on robotsChanged).
const preselectedRobotId: string | null =
  typeof options.preselectedRobotId === "string" && options.preselectedRobotId.length > 0
    ? options.preselectedRobotId
    : null;

// Optional external state observer (mobile-side watchdog). Fired once
// per transition from inside setState(). We never touch it after the
// mount returns - the consumer disposes by unmounting the engine.
const onStateChange: ((state: AppState) => void) | null =
  typeof options.onStateChange === "function" ? options.onStateChange : null;

// Optional external observer for the live WebRTC transport (active ICE
// candidate-pair classification + instantaneous bitrate). Fired by the
// `TransportMonitor` owned by `RobotSession`. The mobile app renders a
// "kind + bitrate" badge in the session topbar from this signal.
//
// Lifecycle-wise the monitor follows the SESSION PC (layer C), NOT the
// conversation pipeline (layer D): the badge is therefore active any
// time the SDK pc is up, regardless of whether the OpenAI Realtime
// conversation has been started.
const onTransportChange: ((info: ConversationTransportInfo) => void) | null =
  typeof options.onTransportChange === "function" ? options.onTransportChange : null;

// ─── Headless UI hooks ──────────────────────────────────────────────────
//
// The mobile app no longer ships any of the conversation engine's old
// DOM (no `#main-circle`, `#circle-caption`, `#tool-toast`, side
// buttons, settings modal, …): React owns the orb and its companions
// in `ConversePanel`. The callbacks below replace what the engine
// used to do imperatively to the DOM, so the React UI stays the
// single source of truth for visuals while the engine keeps its full
// behavioural surface (state machine, audio analysers, tool calls).
//
// All four are optional - falsy means "host doesn't care", and the
// engine quietly skips that emission. We capture them once here so
// the rest of the engine can read them through stable closure refs.

// Lazy getter for the orb DOM element. The host (React) may swap
// the underlying node mid-session (panel unmount/remount on tab
// switch, iframe release/reacquire), so we never capture the
// element value here - only the getter. The audio level monitors
// re-read this on every rAF tick so their CSS-var writes always
// land on whichever element is currently mounted.
//
// Backwards-compat: callers can still pass a raw HTMLElement (or
// null) instead of a getter. We normalise both shapes to a
// getter at this single boundary so the rest of the engine
// doesn't have to care which form was used.
const getAudioLevelsTarget: () => HTMLElement | null = (() => {
  const raw = options.audioLevelsTarget;
  if (typeof raw === "function") return raw;
  if (raw instanceof HTMLElement) return () => raw;
  return () => null;
})();

// Audio-reactivity controller. Owns the lazy `MicLevelMonitor` +
// `AiLevelMonitor` instances, captures the latest smoothed mic
// level into a cached value (exposed through the handle's
// `getMicLevel()` for rAF-driven visuals - no React re-render
// per frame), and forwards every event to the host's optional
// `onLevels` callback untouched. See `./audio-monitors-control.ts`.
const audioMonitors = createAudioMonitorsControl({
  getTarget: getAudioLevelsTarget,
  onLevels:
    typeof options.onLevels === "function" ? options.onLevels : null,
});

const onToolToast: ((toast: ConversationToolToastEvent) => void) | null =
  typeof options.onToolToast === "function" ? options.onToolToast : null;

const onMicMutedChange: ((muted: boolean) => void) | null =
  typeof options.onMicMutedChange === "function"
    ? options.onMicMutedChange
    : null;

const onErrorMessageChange: ((message: string | null) => void) | null =
  typeof options.onErrorMessageChange === "function"
    ? options.onErrorMessageChange
    : null;

const onConnectionAttempt: ((info: ConversationConnectionAttempt | null) => void) | null =
  typeof options.onConnectionAttempt === "function"
    ? options.onConnectionAttempt
    : null;

const emitConnectionAttempt = (
  info: ConversationConnectionAttempt | null,
): void => {
  if (!onConnectionAttempt) return;
  try {
    onConnectionAttempt(info);
  } catch (err) {
    console.warn("[engine] onConnectionAttempt callback threw:", err);
  }
};

// ─── Engine core (shared mutable state) ─────────────────────────────────
//
// `EngineCore` bundles the FSM cursor + the four boolean gates that
// the sub-systems need to coordinate on. Replaces what used to be
// half a dozen `let` variables scattered across this closure. Each
// piece is explicit (greppable, sliceable, testable in isolation),
// and the rest of this file only ever reads/writes through it.
//
// Initial FSM state: mobile-app fast path. HF auth is gated upstream
// by `RemoteSignInScreen`, so by the time the engine boots the token
// is already in `sessionStorage`. Start in `connecting` (spinner, no
// caption flash) so the user never sees the misleading `signed-out`
// intro. The first transition from `boot()` (to `authenticated`, or
// straight to `connecting` if `preselectedRobotId` is set) takes over
// almost immediately.
//
// Initial `convoActiveRequested`: defaults to true (Space-app
// behaviour: tap once → talking). Mobile shell passes `false` so the
// WebRTC DC is brought up during the wake-up animation while the
// antennas / OpenAI / wobbler stay quiet until the user explicitly
// hits "Start conversation".
const core = createEngineCore({
  initialState: "connecting",
  convoActiveRequested: options.autoStartConversation !== false,
});
const { fsm } = core;
const { conversationStarted, convoActiveRequested, unmounted, movePlaying } =
  core.gates;
// Tiny alias so the dozens of `setState("x")` call sites stay terse.
// The FSM owns the cursor + the subscriber fan-out; this is just a
// pretty name for `fsm.set`.
const setState = fsm.set;

// Settings, defaults, OpenAI tool descriptors and head-pose lookup
// table all live in their own modules now to keep this file focused
// on the FSM + orchestration:
//   - `./settings.ts` → `Settings`, `loadSettings()`, defaults, storage keys
//   - `./tools.ts`    → `ROBOT_TOOLS`, `HEAD_POSES`, `HeadPoseName`

// ─── App state machine ──────────────────────────────────────────────────
// `AppState` itself is defined at module scope (above `mountConversation`)
// so `ConversationEngineOptions.onStateChange` can reference it. This
// closure still uses it via the normal outer-scope lookup, nothing else
// to thread.

// Per-state caption + disabled mapping used to live here as
// `STATE_VIEWS` / `STATE_CLASS`. Both are now owned by the React orb
// (see `reachy_mini_mobile_app/src/conversation/orb/ConversationCaption.tsx`
// and the per-state CSS in `orb.css`). The engine just emits
// transitions through `onStateChange` and lets the host translate
// them into a visual.

// ─── Headless surface ───────────────────────────────────────────────────
//
// The engine used to look up half a dozen DOM refs inside `root` and
// drive them imperatively (`#main-circle`, `#circle-caption`, side
// buttons, settings modal, HF user pill, transport pill, …). The React
// host now owns all of that and consumes the engine through callbacks
// (`onStateChange`, `onLevels`, `onToolToast`, …) and handle methods
// (`setMicMuted`, `requestStop`, `triggerOrbAction`). We keep the
// `root` parameter only for `audioLevelsTarget` defaults and as a
// future optional render slot, but we no longer require any specific
// markup inside it.
//
// Anything in this file that used to read or mutate those nodes was
// removed in the same refactor; if you find a stray reference, it
// belongs in the React layer (`reachy_mini_mobile_app/src/conversation/orb`).

void root;

// ─── Runtime state (legacy: see `core` above) ───────────────────────────
//
// The FSM cursor + the four boolean gates that used to live as `let`
// variables here now live in `core` (see the engine-core block above).
// Sub-systems below read/write them through `fsm.current()`,
// `fsm.set(...)`, `conversationStarted.get()`, `movePlaying.on()`, etc.

// Selection state (`selectedRobotId`) and the SDK's robot list cache
// (`knownRobots`) live in the `RobotSession` instance now. Use
// `session.getSelectedRobotId()` / `session.setSelectedRobotId()` /
// `session.setKnownRobots()` everywhere.
const settings: Settings = loadSettings();

// Engine-side closure alias for the SDK robot ref. The canonical
// owner is `session` (see `session.attachRobot()` in `boot()`); this
// `let` is the engine's working copy so the dozens of `robot.X()`
// calls below stay terse instead of spelling `session.getRobot()?.X()`
// each time. Kept in sync with the session via `session.attachRobot()`
// on assignment - the session is the only consumer that needs the
// canonical reference (its lifecycle methods `start`, `release`,
// `reacquire`, `wakeUp`, `sleepAndDisable`, `attachVideo` use it
// internally).
let robot: ReachyMiniInstance | null = null;

// OpenAI session lifecycle (client + audio sink + reconnect
// counters + reconnecting flag) is owned end-to-end by the OpenAI
// bridge below. The engine just observes its events and drives the
// FSM + motion controllers in reaction.
//
// Declared as `let | null` because `toolCallHandler` is created
// EARLIER in the closure (it has no dependency on the bridge) yet
// needs to forward `sendToolResponse` calls to it at runtime. The
// late `=` assignment below resolves the cycle without forward
// declarations or class wrappers.
let openaiBridge: ReturnType<typeof createOpenaiBridge> | null = null;

// Head-motion + antennas oscillator. The actual `HeadWobbler` and
// `AntennasOscillator` instances live inside their respective
// controllers, which expose a small `start / stop / freeze / resume`
// surface so the engine doesn't have to manage their lifecycles
// directly.
//
// Both controllers are stateless until first `start()`. Recreated
// per session for the wobbler (it's bound to the assistant audio
// track), reused across sessions for the antennas.

// Mic + AI level monitors moved to `audioMonitors` (created above
// alongside the host-callback wrapping). They drive the orb's
// `--audio-level`, `--bar0..--bar4`, and `--ai-audio-level` CSS
// custom properties from the inbound mic / OpenAI output tracks,
// and expose the `waitForSilence` tail-end probe + the cached
// `getMicLevel()` value used by the React orb.

// `movePlaying` moved to `core.gates.movePlaying`. The
// `tool-call-handler` module flips it through `onMoveStart` /
// `onMoveEnd`; the wobbler + antennas controllers read it via
// `isMovePlaying: movePlaying.get` so they can yield their 30 Hz
// writes for the duration of a tool-driven choreography.

// Session state holder. Owns the session-level state vars
// (sessionEstablished, lastSetMotorMode), the stop-intent guard
// (expectedStop counter), and the video stream cache. The engine
// keeps owning the FSM, the conversation pipeline and the host
// callbacks - this is purely the session layer underneath.
const session = new RobotSession();
const sessionGuard = session.guard;
const expectedStop = sessionGuard.expectedStop;
const videoCache = session.videoCache;
// Wire the host's transport listener once. The class owns all the
// start/stop bookkeeping internally so the monitor follows the
// session pc lifecycle (`start` / `reacquire` / `stop` / `release` /
// `detachRobot`) without the conversation engine having to know
// anything about candidate pairs.
session.setTransportListener(onTransportChange);

// Reconnect bookkeeping (attempt counter + in-flight flag) is owned
// by the OpenAI bridge. The engine exposes `openaiBridge.isReconnecting()`
// as a read-only view for the few sites that need it.

// Screen keep-awake is no longer driven from the engine. The host
// (`RobotSessionScreen` via `useKeepScreenOn`) owns that policy now
// because it has visibility on both the engine state AND the iframe
// app overlay - the iframe handoff path used to drop the engine's
// wake lock at the exact moment the user needed the screen ON (e.g.
// piloting through Marionette). See
// `shared/tauri/keepScreenOn.ts` for the underlying native plugin
// + Web Wake Lock wrapper.

// The mic-muted flag used to live here so the engine could re-paint
// its own button. The React side controls own that state now (kept
// in sync through `onMicMutedChange`), so the engine just forwards
// the new value to the SDK and lets the host render.

// ─── FSM subscribers ────────────────────────────────────────────────────
//
// Every side effect that used to live inline in the old `setState()`
// body is now an explicit, named subscriber registered here. Order
// matters only loosely (host observer should fire before motor mode
// sync so the React UI updates before the DataChannel write goes
// out), but each subscriber is independent and a throw is caught by
// the FSM so a broken host callback can't take the whole transition
// down.

// 1. Host-facing state observer (React mobile shell, watchdog timers,
//    test loggers). The FSM already logs the transition itself via
//    the `label: "engine"` option in `createEngineCore`, so we don't
//    duplicate that here.
if (onStateChange) {
  fsm.subscribe((next) => {
    try {
      onStateChange(next);
    } catch (err) {
      console.warn("[conversation-engine] onStateChange threw:", err);
    }
  });
}

// 2. Error-message clearing on leave-error. The host typically renders
//    a small caption / tooltip under the orb when in `error`; we drop
//    it as soon as the user navigates away (e.g. tapping retry takes
//    us back to `authenticated`).
if (onErrorMessageChange) {
  fsm.subscribe((next, prev) => {
    if (prev !== "error" || next === "error") return;
    try {
      onErrorMessageChange(null);
    } catch (err) {
      console.warn(
        "[conversation-engine] onErrorMessageChange threw:",
        err,
      );
    }
  });
}

// 3. Daemon-side motor mode dedup, see `syncMotorModeForState` below.
//    Registered last so the user-visible transition has already been
//    fanned out by the time we hit the DataChannel.
fsm.subscribe((next) => syncMotorModeForState(next));

/**
 * Sync the daemon-side motor mode to the new FSM state, with two
 * layers of dedup so we don't flood the data channel with redundant
 * `setMotorMode` calls (every state transition during a back-and-
 * forth conversation would otherwise fire one).
 *
 * Two regimes:
 *   - active conv (`starting`, `listening`, `user-speaking`,
 *     `processing`, `ai-speaking`) → `enabled`. Wobbler / antennas
 *     oscillator + tool-call poses need responsive servoing.
 *   - everything else (`ready`, `released`, `error`, pre-session) →
 *     no-op. We deliberately do NOT switch the robot into a
 *     "compliant" mode on `ready` (we tried `gravity_compensation`
 *     but the daemon's default kinematics engine - non-Placo -
 *     refuses it: "Gravity compensation mode is only supported
 *     with the Placo kinematics engine."). The motors stay in
 *     `enabled` between conversations; the glide-to-neutral
 *     above lands them at exactly (0,0,0) so the residual PID
 *     activity is near-zero and the robot stays calm.
 *
 * The teardown path drives `setMotorMode('disabled')` directly
 * after `gotoSleep` resolves; this helper deliberately stays out
 * of its way.
 */
// `session.getLastMotorMode()` / `session.recordMotorMode()` (was: a
// bare `let lastSetMotorMode: ... = null` here) hold the dedup cache.

function syncMotorModeForState(next: AppState): void {
  if (!robot || !session.isEstablished()) return;
  let mode: "enabled" | null = null;
  switch (next) {
    case "starting":
    case "listening":
    case "user-speaking":
    case "processing":
    case "ai-speaking":
      mode = "enabled";
      break;
    default:
      return;
  }
  // Dedup: most conversation transitions (listening ↔ user-speaking
  // ↔ processing ↔ ai-speaking) all map to the same `enabled` mode.
  // Without this guard the engine would emit a setMotorMode message
  // on every turn boundary - 4-5 redundant DC writes per turn that
  // can interrupt the pose stream and produce visible motion hiccups.
  if (mode === session.getLastMotorMode()) return;
  try {
    robot.setMotorMode(mode);
    session.recordMotorMode(mode);
  } catch (err) {
    console.warn(
      `[engine] setMotorMode(${JSON.stringify(mode)}) failed (ignored):`,
      err,
    );
  }
}

/**
 * Handle the HF central's `robotsChanged` event.
 *
 * The Space original rendered a "Choose a Reachy" picker here. The
 * mobile app always knows which specific robot to talk to before
 * this engine mounts (the user picked it on the ScanScreen from the
 * central robot list), so a picker would only create ambiguity if
 * the account lists several robots. We therefore auto-select the
 * first robot that appears and let `doStart` drive the rest.
 *
 * If the list ever changes mid-session we keep the currently selected
 * robot: churn in the central's view is not a reason to retarget a
 * live session.
 */
function renderRobotList(robots: RobotInfo[]): void {
  session.setKnownRobots(robots);

  if (fsm.current() !== "connected") return;
  if (!robots.length) return;
  // `pickFirstIfNone()` is a no-op if a robot is already selected,
  // so we don't need a separate `getSelectedRobotId()` guard here -
  // the helper returns null and we fall through.
  const picked = session.pickFirstIfNone();
  if (!picked) return;
  setState("auto-selecting");
  window.setTimeout(() => {
    if (fsm.current() === "auto-selecting") void doStart();
  }, 300);
}

// ─── Host-driven controls ──────────────────────────────────────────────
//
// Equivalent of the original DOM click handlers (`#main-circle`,
// `#mic-btn`, `#stop-btn`) but exposed on the `ConversationEngineHandle`
// so the React layer can wire its own components without us touching
// the DOM. Each function is identical in behaviour to its Space-app
// counterpart - the engine still owns the state-machine decisions
// ("error → reset to authenticated", "stop → re-park on connected /
// authenticated"). Only the trigger surface moved from the DOM to a
// method call.

async function handleOrbClick(): Promise<void> {
  try {
    switch (fsm.current()) {
      case "signed-out":
        if (!robot) return;
        await robot.login();
        return;

      case "authenticated":
        await doConnect();
        return;

      case "ready":
        // SDK + DataChannel are up, the robot has woken and motors
        // are enabled. The user just tapped the orb to opt into the
        // AI side: flip `convoActiveRequested` so re-entries do not
        // bounce back to `ready` if the runner is interrupted, and
        // run the conversation pipeline (OpenAI handshake, audio
        // pumps, motion modules). `runConversationParts` itself
        // re-arms `setState("starting")` to keep the orb honest.
        convoActiveRequested.on();
        await runConversationParts();
        return;

      case "error":
        session.setSelectedRobotId(null);
        if (robot?.isAuthenticated) {
          setState("authenticated");
        } else {
          setState("signed-out");
        }
        return;

      default:
        return;
    }
  } catch (err) {
    onFatalError(err);
  }
}

function applyMicMuted(next: boolean): void {
  // Mute = gate the robot's mic track we forward to OpenAI, so the
  // assistant stops HEARING the user (matches the MicOff button).
  //
  // This goes through the bridge, NOT `robot.setMicMuted()`: since
  // SDK 1.8.0 the SDK no longer owns a getUserMedia stream, so its
  // `setMicMuted` is a silent no-op (it gates a null `_micStream`).
  // The bridge owns the robot-mic→OpenAI routing, so the gate lives
  // there and survives transparent reconnects.
  try {
    openaiBridge?.setMicMuted(next);
  } catch (err) {
    console.warn("[conversation-engine] setMicMuted failed:", err);
  }
  if (onMicMutedChange) {
    try {
      onMicMutedChange(next);
    } catch (err) {
      console.warn("[conversation-engine] onMicMutedChange threw:", err);
    }
  }
}

async function handleHostStop(): Promise<void> {
  await teardown();
  session.setSelectedRobotId(null);
  applyMicMuted(false);
  if (!robot) {
    setState("signed-out");
  } else if (robot.state !== "disconnected") {
    setState("connected");
    renderRobotList(session.getKnownRobots() as RobotInfo[]);
  } else if (robot.isAuthenticated) {
    setState("authenticated");
  } else {
    setState("signed-out");
  }
}

// ─── High-level flow steps ──────────────────────────────────────────────

async function doConnect(): Promise<void> {
  if (!robot) return;
  console.log("[shell-webrtc] doConnect: entering, robot.state =", robot.state);
  setState("connecting");
  try {
    // WebKit privacy quirk on iOS: get the LAN host candidates flowing
    // *before* we kick off the SDK's `connect()` (which immediately
    // starts ICE gathering). This is also where Android first surfaces
    // the RECORD_AUDIO prompt. Idempotent. On desktop the call still
    // runs but `shared/desktop-mic-shim.ts` rejects the underlying
    // `getUserMedia({audio:true})`, so it boils down to a noisy warn
    // and no actual mic capture. See
    // `features/conversation/permissions/iosMicUnlock.ts` for the full
    // rationale of the mobile path.
    await unlockIosMicForWebRtc().catch(() => undefined);

    // The SDK refuses a second `connect()` when already in `connected` /
    // `streaming`. Our stop button only tears the *session* down
    // (`stopSession`), so the daemon WebRTC is still up afterwards and
    // we must skip `connect()` to avoid the "Already connected" throw.
    if (robot.state === "disconnected") {
      const t0 = performance.now();
      console.log("[shell-webrtc] doConnect: calling robot.connect()...");
      await robot.connect();
      console.log(
        `[shell-webrtc] doConnect: connect resolved in ${Math.round(
          performance.now() - t0,
        )}ms, robot.state = ${robot.state}, robots = [${robot.robots
          .map((r) => r.id)
          .join(",")}]`,
      );
    } else {
      console.log(
        "[shell-webrtc] doConnect: already connected, skipping connect()",
      );
    }
    setState("connected");

    // Fast path (mobile): we already know which robot to talk to from
    // the ScanScreen selection (central robot list), so skip the
    // robotsChanged wait and drive straight into startSession. If the
    // id turns out to be stale / wrong, doStart → onFatalError will
    // surface the error and the user can retry; we explicitly don't
    // fall back to the picker flow here because picking a different
    // robot on an account that owns several would contradict the
    // user's explicit selection and violate the least-surprise
    // principle.
    if (preselectedRobotId) {
      session.setSelectedRobotId(preselectedRobotId);
      setState("auto-selecting");
      await doStart();
      return;
    }

    // Classic path: replay the last robotsChanged snapshot (if the
    // event fired during connect, which it often does) and let
    // renderRobotList auto-pick the first robot or keep waiting.
    renderRobotList(session.getKnownRobots() as RobotInfo[]);
  } catch (err) {
    onFatalError(err);
  }
}

async function doStart(): Promise<void> {
  if (!robot || !session.getSelectedRobotId()) return;
  console.log(
    `[shell-webrtc] doStart: entering, selectedRobotId = ${session.getSelectedRobotId()}, robot.state = ${robot.state}`,
  );

  // The OpenAI key gate used to live here, gating `robot.startSession()`
  // entirely. That was the wrong layer: `startSession()` is what opens
  // the WebRTC DataChannel that the daemon proxy (`http_proxy` over
  // DC) rides on, and the daemon proxy is needed for the daemon-status
  // pill, the wake/sleep choreography, and the `engine.bringup`
  // watchdog regardless of whether a conversation will run. The mobile
  // shell wants the robot connected first (so the user lands in a
  // working session screen), and only asks for the OpenAI key when
  // they explicitly hit "Start conversation". The gate now lives in
  // `runConversationParts()` so the WebRTC negotiation is unblocked
  // for users without an OpenAI key.

  setState("starting");

  // NB: we deliberately do NOT call robot.stopSession() here as a
  // preemptive cleanup. It seems safe on paper ("send endSession for
  // any lingering session before starting a new one"), but the SDK
  // plumbs stopSession into the SAME session id that `robot.connect()`
  // just established for the producer subscription — so calling it
  // while we're still in the middle of the startSession handshake
  // tears down our OWN just-created peer state and central comes
  // back with "Session ended before it could start: unknown reason"
  // followed by "Producer <id> not found" on the retry. The phantom
  // locked sessions this was meant to clear belong to a previous
  // peer that no longer exists; the daemon-side /refresh-relay
  // endpoint and the 15s timeout below cover those cases instead.

  // Bring the WebRTC session up. `session.start()` wraps the retry
  // loop + per-attempt timeout + libnice-crash recovery
  // (see `features/robot-session/start-session.ts`); the
  // `expectedStop` semantics are baked in through the session's
  // composed guard, so internal stopSession bailouts on timeout
  // don't trigger the engine's unsolicited-drop recovery path.
  const tDoStart0 = performance.now();
  console.log(`[DIAG] doStart: calling session.start() at t=0`);
  const result = await session.start({
    onAttempt: (info) => {
      console.log(
        `[DIAG] doStart: emitConnectionAttempt(${JSON.stringify(info)}) at ` +
          `t+${Math.round(performance.now() - tDoStart0)}ms`,
      );
      emitConnectionAttempt(info);
    },
    isCancelled: () => !session.getRobot() || !session.getSelectedRobotId(),
  });
  console.log(
    `[DIAG] doStart: session.start() resolved ok=${result.ok} at t+${Math.round(
      performance.now() - tDoStart0,
    )}ms`,
  );

  if (!result.ok) {
    if (result.cancelled) return;
    onFatalError(result.reason);
    return;
  }

  // Wake the robot now that the data channel is live. We AWAIT the
  // wake-up here so the host's "Connecting to your Reachy" transition
  // view stays up for the duration of the wake animation (~2 s on a
  // healthy robot). The state machine doesn't flip to `ready` until
  // motors are actually enabled and the head / antennas have settled
  // into their wake pose - that matches the user's mental model
  // ("ready" means physically online, not just "WebRTC handshake
  // complete"). `session.wakeUp()` enforces a JS-side hard timeout
  // so a stuck daemon never blocks our progress to `ready`.
  const tBeforeWake = performance.now();
  console.log(`[DIAG] doStart: about to await session.wakeUp() at t+${Math.round(tBeforeWake - tDoStart0)}ms`);
  await session.wakeUp();
  console.log(
    `[DIAG] doStart: session.wakeUp() resolved in ${Math.round(
      performance.now() - tBeforeWake,
    )}ms (total t+${Math.round(performance.now() - tDoStart0)}ms)`,
  );

  // Apply the tuned XVF3800 audio-board parameters now that the
  // DataChannel is live. This mirrors `apply_audio_startup_config`
  // in reachy_mini_conversation_app — without it the mic gain is
  // too low for the Realtime voice loop. Best-effort: a missing
  // audio board (Lite / dev) just warns and returns false. See
  // issue #21 / upstream PR #1058.
  if (robot) {
    await applyAudioStartupConfig(robot);
  }

  // Mark the SDK / DataChannel as ready BEFORE deciding whether to
  // continue with the conversation parts. The mobile app gates the
  // conversation pipeline behind a "user clicked Start" UI flag (see
  // `handle.startConversation()`), so we may end up parking here with
  // a live DC and no antennas/OpenAI - that's the desired state during
  // the wake-up animation. `setSessionEstablished` flips so the host
  // can pick up where we left off when it flips the gate.
  setSessionEstablished(true);

  if (!convoActiveRequested.get()) {
    // SDK + DataChannel are up, wake-up was fired, motors are
    // enabled - everything is "ready" except the AI side. Park
    // here and surface the `ready` state so the host can render
    // the orb's "press to start" affordance. The user's tap on
    // the orb routes through `handleOrbClick("ready")` which
    // calls `runConversationParts()` to bring up OpenAI Realtime
    // + the audio pumps + motion modules.
    console.log(
      `[DIAG] doStart: setState("ready") at t+${Math.round(performance.now() - tDoStart0)}ms`,
    );
    setState("ready");
    return;
  }

  await runConversationParts();
}

/**
 * The conversation pipeline proper: antenna oscillator, head wobbler,
 * OpenAI Realtime client, mic plumbing. Split out of `doStart` so the
 * mobile app can defer it until the user is in the right view (the
 * SDK / DataChannel is brought up earlier because it doubles as the
 * daemon proxy transport during wake-up).
 *
 * Idempotent: repeated calls are safe. If the SDK isn't ready yet
 * (e.g. host called `startConversation()` before `startSession()`
 * resolved) the call is recorded via `convoActiveRequested` and
 * `doStart` will pick up where we left off.
 */
async function runConversationParts(): Promise<void> {
  if (!robot || conversationStarted.get()) return;

  // OpenAI access gate. We used to check a build-time-baked API key
  // here; the mobile shell now mints per-user ephemeral keys against
  // the website's `/api/openai/ephemeral` endpoint (see
  // `./ephemeral-key.ts`), so the only failure mode pre-handshake
  // is "the user isn't signed in to Hugging Face". That is normally
  // impossible by the time the engine boots (the auth gate in
  // `App.tsx` keeps the UI on the sign-in screen until a token is
  // in `sessionStorage`), but we still defensively probe so a stale
  // state or a token-expiry race surfaces as a clear UI message
  // instead of a vague handshake failure two seconds later.
  // Arm the "starting" UI *before* the ephemeral-key mint so the orb
  // flips to its connecting spinner the instant the user taps. The mint
  // is a network round-trip to the website's `/api/openai/ephemeral`
  // endpoint (hundreds of ms on a cold first start) and used to run
  // while the state was still `ready`, leaving the orb visually idle
  // during that latency. From the deferred (tap-to-start) path the FSM
  // is in `ready` here; from the auto-start path it's already
  // `starting`, so this is a no-op there.
  if (fsm.current() === "ready") setState("starting");

  try {
    await mintEphemeralKey();
  } catch (err) {
    const message =
      err instanceof EphemeralKeyError && err.reason === "hf_token_missing"
        ? "Sign in to Hugging Face to start a conversation"
        : "Could not reach the OpenAI key service. Retry in a moment.";
    if (onErrorMessageChange) {
      try {
        onErrorMessageChange(message);
      } catch (callbackErr) {
        console.warn(
          "[conversation-engine] onErrorMessageChange threw:",
          callbackErr,
        );
      }
    }
    console.warn("[conversation-engine] ephemeral key prefetch failed:", err);
    convoActiveRequested.off();
    // The robot side stays usable - DataChannel is alive, motors are
    // enabled, wake-up has played - so drop back to `ready` and let
    // the user retry by tapping the orb again once they've fixed the
    // upstream condition (signed in, network back, ...).
    if (fsm.current() === "starting") setState("ready");
    return;
  }

  conversationStarted.on();

  // ("starting" was already armed before the mint above, so the orb's
  // connecting spinner has been showing since the user's tap.)

  // Grab the robot's incoming audio track (the robot's microphone).
  const robotMicTrack = openaiBridge?.getRobotMicTrack(robot) ?? null;
  if (!robotMicTrack) {
    conversationStarted.off();
    onFatalError(new Error("Could not find the robot's microphone track"));
    return;
  }

  audioMonitors.startMic(robotMicTrack);
  // Bring the motion stack up (pose dispatcher + antennas
  // oscillator). The wobbler waits for its AI track via the
  // bridge's `onOutputTrack` callback, which forwards into
  // `motion.attachAiOutput`. Idempotent on re-acquire paths: a
  // running dispatcher / oscillator stays running.
  motion.startSession();
  // Spin up the silent keepalive AudioContext so iOS treats us as
  // an actively-playing audio app and grants background time when
  // the user locks the screen / switches apps mid-conversation.
  // Idempotent (no-op if already running on a re-acquire path).
  backgroundAudioKeeper.start();

  // Reset the bridge's per-session retry budget so a stale failure
  // from a previous run can't poison this fresh handshake.
  openaiBridge?.resetReconnectCounter();
  try {
    await openaiBridge?.connect(robotMicTrack);
  } catch (err) {
    conversationStarted.off();
    onFatalError(err);
    return;
  }

  // Conversation is now fully active (handshake done, output track
  // routed, data channel open). Start the passive scene-awareness
  // module: it'll grab a first frame in ~1.5 s, then every 30 s,
  // plus immediately on any STT keyword trigger. Idempotent; survives
  // transparent reconnects through the bridge's `RealtimePort`.
  //
  // Gated on the user's conversation setting (read lazily here, at
  // start time): when scene-awareness is off we simply never start the
  // poller, so no frames are ever captured. The setting can only be
  // toggled while stopped, so this start-time read is authoritative
  // for the whole conversation.
  if (isVisionEnabled()) vision?.start();

  // Every fresh conversation starts unmuted. Routed through the bridge
  // (not the inert SDK `setMicMuted`) so it also clears any mute state
  // a previous session left on the bridge — a new session must never
  // inherit a stale mute. Transparent reconnects, by contrast, go
  // through `bridge.connect()` which re-applies the live mute state.
  openaiBridge?.setMicMuted(false);

  // Release the iOS phone-microphone claim now that the bridge has
  // replaced the SDK's outgoing audio sender with OpenAI's output
  // track.
  //
  // Background. The vendored SDK calls `getUserMedia({audio:true})`
  // during `startSession()` (`_enableMicrophone: true`) and stashes
  // the resulting MediaStream as `_micStream`, then attaches its
  // tracks to the WebRTC `_pc` as audio senders. Even though we
  // immediately swap those senders' tracks for OpenAI's output via
  // `audioSender.replaceTrack(...)` and the SDK's tracks have
  // `enabled = false` from creation, iOS still considers the phone
  // mic "captured" by the app for as long as a non-stopped
  // MediaStreamTrack from `getUserMedia({audio})` is alive. Result:
  // the orange mic indicator in the status bar stays lit while the
  // user is on the Apps / Robot tab (or with the app
  // backgrounded), even though no audio is actually being recorded
  // from the phone.
  //
  // Stopping the captured tracks here releases the iOS audio
  // session's mic claim. The WebRTC sender is unaffected because
  // the bridge already swapped it for the OpenAI track above; the
  // tracks we're stopping are dangling references the SDK no
  // longer pumps data into. Idempotent against subsequent
  // `runConversationParts()` calls (a re-acquire after release):
  // the SDK regenerates `_micStream` on every `startSession`, so
  // this stop runs exactly once per session.
  releaseSdkPhoneMic(robot);
}

/**
 * Thin wrapper around `session.setEstablished()`. Kept as a function
 * so the assignment sites stay greppable and we have a future hook
 * point for test instrumentation / observers.
 */
function setSessionEstablished(value: boolean): void {
  session.setEstablished(value);
}

// ─── Tool-call handler ─────────────────────────────────────────────────
//
// `tools/tool-call-handler.ts` owns the OpenAI tool-call dispatch
// (`move_head`, `play_move`, `remember`, `forget`), the lazily-created
// `MovePlayer`, and the head-pose restore timer. We feed it the
// engine state it needs through getters and listen to its
// `onMoveStart` / `onMoveEnd` callbacks so the wobbler + antennas
// pause cleanly during a choreography.

const toolCallHandler = createToolCallHandler({
  getRobot: () => robot,
  // Late-bound through the bridge variable below: the bridge is
  // created AFTER this handler so we can pass `handleToolCall` into
  // its `onToolCall` deps without a circular reference. The `?? false`
  // guard covers the brief window between the engine starting and
  // the bridge being assigned (during which a tool call cannot
  // realistically happen anyway), plus the post-teardown window
  // after `unmount()`.
  sendToolResponse: (callId, result) =>
    openaiBridge?.sendToolResponse(callId, result) ?? false,
  onMoveStart: () => {
    movePlaying.on();
  },
  onMoveEnd: () => {
    movePlaying.off();
  },
  // Coerce `null` (engine convention for "no observer") to `undefined`
  // (handler convention from the optional callback shape).
  onToolToast: onToolToast ?? undefined,
});

// ─── Background-tab resilience ──────────────────────────────────────────
//
// Browsers throttle JS timers and may suspend AudioContexts in hidden
// tabs. The WebRTC media stack itself is native and keeps running, so
// the voice conversation continues to flow - but:
//   - our VAD / wobbler / mic-level analysers stop updating
//   - AudioContexts can end up suspended on return (Safari, mobile)
//   - a device sleep during silence can kill everything
//
// The keep-screen-on side of that mitigation lives in the host
// (`RobotSessionScreen` via `useKeepScreenOn`). The engine only owns
// the audio-context resume on visibility return, below.

function resumeAudioContexts(): void {
  // HeadWobbler, MicLevelMonitor and AiLevelMonitor each own a private
  // AudioContext that some browsers (notably Safari / iOS) suspend
  // when the tab goes into the background. Wake them back up.
  // (AntennasOscillator has no AudioContext - it's purely time-based,
  // hence no resume on the motion side beyond `motion.resumeAudio()`.)
  motion.resumeAudio();
  audioMonitors.resumeAudio();
}

// `visibilitychange`, `pagehide` and `beforeunload` are all managed
// from `installBackgroundResilience()` near the bottom of the
// `mountConversation` body, alongside the `unmount()` disposer that
// removes them on engine teardown.

// ─── Robot data-channel health ─────────────────────────────────────────
//
// `runtime/dc-health.ts` owns the bookkeeping (failure streak counter
// + threshold-based escalation + neutral-antenna heartbeat). We pass
// it a robot getter and a fatal callback so it stays decoupled from
// the engine's other state.

const dcHealth = createDcHealthMonitor({
  getRobot: () => robot,
  onFatalLink: (err) => {
    void onFatalError(err);
  },
});

const recordSend = dcHealth.recordSend;
const probeRobotLink = dcHealth.probeRobotLink;

// ─── Motion stack ──────────────────────────────────────────────────────
//
// `motion-control/orchestrator.ts` bundles the three low-level motion
// controllers - pose dispatcher, head wobbler, antennas oscillator -
// behind a single named API the engine drives from FSM transitions
// and lifecycle events:
//
//   - `startSession()` / `attachAiOutput(track)` / `stop({ glide })`
//     for the conversation-pipeline lifecycle.
//   - `onUserSpeak()` / `onAiSpeak()` / `onListening()` /
//     `onProcessing()` / `onReconnecting()` for per-FSM-event hooks
//     (each captures "the right thing to do on the motion side in
//     state X" in exactly one place).
//   - `resumeAudio()` to wake the wobbler's private AudioContext on
//     visibility return.
//
// The dispatcher coalesces the wobbler's 20 Hz head writes + the
// antennas oscillator's 30 Hz writes into ONE `set_full_target` per
// 30 Hz tick (with SCTP backpressure throttling). See the
// orchestrator file's docstring for the full rationale.
const motion = createMotionOrchestrator({
  getRobot: () => robot,
  isPoseLocked: () => toolCallHandler.isPoseLocked(),
  isMovePlaying: movePlaying.get,
  recordSend,
});

// Background-audio keepalive. Started alongside the conversation
// pipeline so iOS keeps the WKWebView scheduled when the user puts
// the phone in their pocket / locks the screen mid-conversation.
// See `../background-audio-keeper.ts` for the rationale + the
// matching `UIBackgroundModes = audio` declaration in the iOS
// Info.plist (without which this runtime piece does nothing).
const backgroundAudioKeeper: BackgroundAudioKeeper =
  createBackgroundAudioKeeper();

// ─── OpenAI bridge ─────────────────────────────────────────────────────
//
// `bridge/openai-bridge.ts` owns the entire OpenAI Realtime session:
//   - Client construction + SDP handshake
//   - Routing the AI output track to the robot's audio sender
//   - Hidden `<audio>` sink so browsers actually decode the inbound track
//   - One-shot transparent reconnect on transient errors
//   - Mic-track lookup helper
//
// The engine reacts to its events (`onStatus`, `onOutputTrack`,
// `onToolCall`, `onReconnecting`, `onFatalError`) by driving the FSM,
// motion controllers and audio analysers. The bridge itself stays
// blissfully unaware of any of that.

openaiBridge = createOpenaiBridge({
  getRobot: () => robot,
  // Each handshake pulls a fresh-enough ephemeral key from the
  // website server (`/api/openai/ephemeral`). The mint module
  // owns its own cache + invalidation so the bridge can simply
  // `await deps.getApiKey()` every connect/reconnect.
  getApiKey: mintEphemeralKey,
  model: settings.model,
  // Resolve the voice lazily (re-read on every `buildClient()` so
  // a personality switch picks up the new voice on the next
  // reconnect, without needing to rebuild the bridge). Falls back
  // to the engine's `DEFAULT_VOICE` when the active personality
  // doesn't override it.
  voice: () => {
    const personality = getActivePersonality();
    return personality.voice && personality.voice.length > 0
      ? personality.voice
      : settings.voice;
  },
  composeInstructions: () => {
    // Snapshot the user's long-term memory ONCE per connection. We
    // intentionally don't push live updates to the OpenAI session: a
    // `remember` call mid-conversation already carries its fact in
    // the tool-call transcript, so the model knows it's saved
    // without needing the prompt to be re-pushed. The next session
    // start (or an explicit reconnect) is when stale memories get
    // refreshed.
    //
    // The base instructions come from the active personality (the
    // built-in default when the user hasn't picked one) so a
    // personality switch propagates here on the next reconnect
    // without any explicit wiring beyond reading the store.
    const personality = getActivePersonality();
    const baseInstructions =
      personality.instructions && personality.instructions.length > 0
        ? personality.instructions
        : settings.instructions;
    // Memory + vision prompt fragments are each gated on the user's
    // conversation setting (read lazily here, per reconnect). When a
    // feature is off we drop its fragment entirely so the model isn't
    // primed to use a capability it doesn't have this session (memory
    // tools are also filtered out below at the bridge level).
    const memoryFragment = isMemoryEnabled() ? memoryStore.formatForPrompt() : "";
    const visionAppendix = isVisionEnabled() ? getVisionPromptAppendix() : "";
    // Language nudge. Read lazily from the conversation-language
    // store on every reconnect so a mid-session switch (user taps
    // the flag picker -> ConversationPanel restarts the conv)
    // propagates without any extra wiring. The fragment instructs
    // the model to default to the selected language AND honour an
    // explicit user request to switch, so the voice-driven
    // "parle-moi en français" path keeps working on top of it.
    const languageAppendix = getLanguagePromptAppendix(getActiveLanguageId());
    const parts = [baseInstructions];
    if (memoryFragment) parts.push(memoryFragment);
    if (visionAppendix) parts.push(visionAppendix);
    parts.push(languageAppendix);
    return parts.join("\n\n");
  },
  // Tool set resolved lazily per connect so the memory toggle takes
  // effect on the next conversation start without rebuilding the
  // bridge. When long-term memory is off we drop the `remember` /
  // `forget` tools so the model can't write to (or read intent about)
  // a store the user has disabled; the matching prompt digest is also
  // omitted in `composeInstructions` above.
  tools: () =>
    isMemoryEnabled()
      ? ROBOT_TOOLS
      : ROBOT_TOOLS.filter((t) => t.name !== "remember" && t.name !== "forget"),
  onStatus: (status) => {
    // Once the user has tapped stop we park the orb in `stopping`
    // (spinner) and run a gentle ~700 ms teardown. The OpenAI bridge
    // can still emit a trailing status as it closes (a final
    // `connected` from the in-flight response completing, or a late
    // activity flip) which would otherwise call `setState("listening")`
    // below and yank the orb straight back into a live look,
    // swallowing the "ending" spinner. Ignore status events while we
    // are deliberately winding down.
    if (fsm.current() === "stopping") return;
    switch (status) {
      case "connected":
        // `connected` arrives from the SDK both (a) when the WebRTC
        // pipe is up for the very first time and (b) when a response
        // completes. In the latter case the trigger used to be
        // `response.done`, which fires before any of Reachy's audio
        // has finished playing - we would flip back to `listening`
        // up to a second early. The bridge now waits for the GA
        // WebRTC-only `output_audio_buffer.stopped` server event
        // before flipping to `connected`, so by the time we land
        // here the server has drained its outbound buffer for this
        // response. Reference:
        // https://platform.openai.com/docs/guides/realtime-conversations#client-and-server-events-for-audio-in-webrtc
        //
        // That leaves only the playout chain to absorb: the local
        // jitter / playout buffer (~150 ms via PLAYOUT_DELAY_HINT_S
        // in openai-realtime.ts) plus whatever Reachy's own audio
        // pipeline buffers downstream. We use the output analyser
        // as a precise tail-end probe (the orb is still listening
        // to the actual track) with a much shorter quiet window
        // than before; 400 ms is enough to ride out the playout
        // buffer without keeping the speaker icon up for a noticeable
        // beat past the actual audio.
        if (fsm.current() === "ai-speaking") {
          audioMonitors.waitForAiSilence(400, () => {
            // Another event may have moved us elsewhere in the
            // meantime (user barge-in, error, teardown). Only
            // transition if we're still the ones holding the mic.
            if (fsm.current() === "ai-speaking") {
              setState("listening");
              motion.onListening();
            }
          });
        } else {
          setState("listening");
          motion.onListening();
        }
        break;
      case "user-speaking":
        // Barge-in: cancel any queued "back to listening" from a
        // previous response so it doesn't overwrite the new state a
        // few hundred ms after the user started talking.
        audioMonitors.cancelAiSilenceWait();
        setState("user-speaking");
        motion.onUserSpeak();
        break;
      case "processing":
        setState("processing");
        motion.onProcessing();
        break;
      case "ai-speaking":
        audioMonitors.cancelAiSilenceWait();
        setState("ai-speaking");
        motion.onAiSpeak();
        break;
    }
  },
  onOutputTrack: (track) => {
    motion.attachAiOutput(track);
    audioMonitors.startAi(track);
  },
  onToolCall: (call) => {
    void toolCallHandler.handleToolCall(call);
  },
  onReconnecting: () => {
    // The bridge is rebuilding the OpenAI peer. Pause motion
    // (their input track is about to go away) and drop the orb
    // back to a transient "starting" visual.
    setState("starting");
    motion.onReconnecting();
  },
  onFatalError: (err) => {
    void onFatalError(err);
  },
});

// ─── Vision side-channel ───────────────────────────────────────────────
//
// Passive scene-awareness module (see `docs/VISION.md`). Polls the
// robot's camera every 30 s + on STT keywords ("regarde", "look", …)
// and injects short `<scene_observation>` blocks into the Realtime
// context. The handle is null when no HF token is available -
// `attachVision` returns `null` and every call site below stays a
// no-op via optional chaining.
//
// Lifecycle:
//   - `start()` after a successful Realtime handshake (in
//     `runConversationParts`, post `openaiBridge.connect`).
//   - `stop()` whenever the conversation pipeline goes down but the
//     engine may bring it back (`teardown`, `stopConversation`,
//     `releaseSessionKeepAwake`). `stop()` is idempotent.
//   - `dispose()` only in the `unmount` handle (terminal release;
//     after this the handle is dead and `start()` is a no-op).
// The poller survives transparent reconnects naturally: the
// `RealtimePort` it talks to keeps its subscriptions and re-attaches
// listeners on every fresh `buildClient()` inside the bridge.
//
// Backend
// -------
// The VLM provider (`vision/providers/hf-vlm-provider.ts`) hits
// Hugging Face's Inference Providers router
// (`router.huggingface.co/v1/responses`) with the USER'S OWN HF
// token - the same token already in `sessionStorage.hf_token` for
// the OpenAI Realtime ephemeral mint flow. This deliberately
// decouples vision from the OpenAI Realtime pipeline:
//
//   - No master OpenAI key on the wire (would require a server-side
//     proxy and we'd own the bill).
//   - Per-user billing: each user's calls land on their own HF tier
//     ($0.10/mo free, $2/mo on PRO, pay-as-you-go beyond), so a
//     runaway user can't drain a shared budget.
//   - Backend-swap-friendly: changing the conversation backend
//     (replacing gpt-realtime-2 with something else later) doesn't
//     touch vision; changing the VLM model is a one-line config
//     edit in `vision/config.ts` (no app rebuild needed if the
//     env override `VITE_VISION_HF_MODEL` is used).
const vision: VisionHandle | null = openaiBridge
  ? attachVision({
      realtime: openaiBridge.getRealtimePort(),
      getVideoStream: () => videoCache.get(),
      getHfToken: readHfTokenFromStorage,
    })
  : null;

/**
 * Common tear-down of the conversation pipeline (D layer).
 *
 * Three orchestration paths all need to stop the vision poller,
 * tool-call handler, antennas / wobbler, OpenAI bridge, pose
 * dispatcher, audio monitors and background audio keeper in the
 * exact same order:
 *
 *   - `stopConversation()`         park in `ready`, glide head to neutral
 *   - `releaseSessionKeepAwake()`  step 1, glide, then release + park `released`
 *   - `teardown()`                 no glide (gotoSleep owns the head trajectory)
 *
 * Before this helper existed the three blocks were copy-pasted and
 * drifted on every change (a new motion controller, a new gate to
 * reset). Centralising them here means a new actor in the pipeline
 * is added exactly once, in the right order, for every consumer.
 *
 * Behaviour
 * ─────────
 * Idempotent: no-op when `conversationStarted` is already false.
 *
 * `glide` controls whether we play the 700 ms ease-out to neutral
 * before stopping the pose dispatcher. `true` for the gentle stops
 * (the user sees the robot settle); `false` for the power-off path
 * where `gotoSleep` is about to take over the head + antennas
 * trajectory and any glide frame would just fight the daemon-side
 * sleep animation.
 *
 * Side effects (in order):
 *   1. clear `convoActiveRequested` so a concurrent
 *      `startConversation()` doesn't race the tear-down;
 *   2. stop vision / tools / wobbler / antennas synchronously;
 *   3. close the OpenAI bridge (awaited in parallel with the glide
 *      when `glide === true`);
 *   4. stop the pose dispatcher, level monitors, background keeper;
 *   5. mute the robot mic so any in-flight audio doesn't leak;
 *   6. clear `conversationStarted`.
 *
 * Post-pipeline tail (park ready / release / sleep+stopSession) is
 * the responsibility of each caller - this helper stays
 * agnostic of the surrounding orchestration.
 */
async function tearDownConversationPipeline({
  glide,
}: {
  glide: boolean;
}): Promise<void> {
  if (!conversationStarted.get()) return;

  // Clear the convo-gate first: a stale `startConversation()` call
  // racing the tear-down could otherwise resurrect the pipeline
  // mid-shutdown. The other paths (teardown, release) also benefit
  // from a clean slate for the next bring-up cycle.
  convoActiveRequested.off();

  vision?.stop();
  toolCallHandler.stop();
  movePlaying.off();

  // Tear the motion stack down. `glide: true` plays a 700 ms
  // ease-out to neutral in parallel with the OpenAI bridge close
  // so the next bring-up (or the iframe handover) inherits a
  // calmly-posed robot. `glide: false` is the power-off path:
  // `gotoSleep` is about to own the head + antennas trajectory
  // and any glide frame here would just fight the daemon-side
  // sleep animation. The orchestrator stops the dispatcher last,
  // after the glide + bridge close have settled.
  await motion.stop({
    glide,
    concurrentTask: openaiBridge?.close(),
  });
  openaiBridge?.resetReconnectCounter();

  audioMonitors.stopMic();
  audioMonitors.stopAi();
  // Drop the keepalive AudioContext so iOS lets the audio session
  // revert to `Ambient` and we go back to plain foreground-only
  // behaviour. Safe to call when not running.
  backgroundAudioKeeper.stop();

  // Mute the robot mic so any in-flight audio frames don't leak
  // through to the speakers while the OpenAI client is gone. Safe
  // on the power-off path too - the session is about to be torn
  // down anyway; `handleHostStop` unmutes again after `teardown()`
  // returns when it's a stop-not-power-off.
  try {
    robot?.setMicMuted(true);
  } catch {
    // ignored
  }

  conversationStarted.off();
}

async function teardown(): Promise<void> {
  // Pipeline tear-down WITHOUT glide: gotoSleep is about to play
  // its own head + antennas trajectory and we don't want our 700ms
  // ease-out fighting it on the bus.
  await tearDownConversationPipeline({ glide: false });

  // Capture the session flag BEFORE resetting it - we need it to
  // decide whether to run the goto-sleep dance below. Resetting
  // first (the previous version did exactly that) made the
  // `if (sessionEstablished)` guard always fall through, so the
  // robot stayed wide awake on disconnect with motors enabled and
  // the head/antennas frozen wherever the last frame put them.
  const wasSessionEstablished = session.isEstablished();

  // `conversationStarted` is already false (cleared inside
  // `tearDownConversationPipeline`); we just need to flip the
  // session flag here so the next `connect → startSession →
  // startConversation` cycle starts from a clean slate.
  session.setEstablished(false);

  // Self-contained: play the goto-sleep trajectory + release motors
  // BEFORE we tear the WebRTC session. Sending the command after
  // `stopSession()` would race the data channel close - the daemon
  // would either drop the request or play sleep into the void.
  //
  // We bound this with a timeout: a wedged daemon shouldn't block
  // teardown indefinitely. The new SDK exposes `gotoSleep` as a
  // Promise that resolves on the daemon's `completed: true` ack;
  // the `globals.ts` type still calls it `boolean` (legacy from
  // pre-promise SDK) but at runtime it's a Promise, so we await it
  // with a defensive cast.
  if (wasSessionEstablished && robot) {
    // `session.sleepAndDisable()` plays the goto-sleep trajectory,
    // hard-bounded by a JS timeout, then forces motor mode to
    // `'disabled'` deterministically (the daemon's own motor mode
    // handling after gotoSleep varies across revisions). Both steps
    // run BEFORE `stopSession()` below so they land while the
    // WebRTC DataChannel is still up. The result is recorded in
    // the session's motor-mode dedup cache automatically.
    const tSleep0 = performance.now();
    console.log(`[DIAG] teardown: about to await session.sleepAndDisable()`);
    await session.sleepAndDisable();
    console.log(
      `[DIAG] teardown: session.sleepAndDisable() resolved in ${Math.round(
        performance.now() - tSleep0,
      )}ms — about to stopSession`,
    );
  }

  if (robot) {
    // Wrapped in `expectedStop` so the `sessionStopped` listener
    // doesn't try to run its own (now redundant) cleanup path. The
    // teardown() function above already handles motor mode, audio
    // monitors and conversation parts; the listener would otherwise
    // also reset `selectedRobotId` and force a
    // state transition, racing with the calling site (handleHostStop
    // / unmount / the fatal-error handler).
    await expectedStop(() => robot!.stopSession());
  }
}

async function onFatalError(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[main] error:", err);
  setState("error");
  // The React caption shows a short "Tap to retry" copy; the full
  // message goes through a dedicated callback so the host can show it
  // as a tooltip / detail line under the orb without us reaching into
  // the DOM.
  if (onErrorMessageChange) {
    try {
      onErrorMessageChange(message);
    } catch (callbackErr) {
      console.warn(
        "[conversation-engine] onErrorMessageChange threw:",
        callbackErr,
      );
    }
  }
  await teardown();
}

// ─── Robot event wiring ─────────────────────────────────────────────────
// The full set of SDK listeners (probes, `robotsChanged`,
// `sessionStopped`, `videoTrack`, `disconnected`, `error`) lives in
// `./robot-events.ts`. The engine just passes its closure-captured
// helpers in - no state inside the wiring function itself.

// ─── Boot ───────────────────────────────────────────────────────────────
// `consumeTokenFromHash()` and `whenReachyReady()` live in
// `./tokenHash.ts`. The first reads the HF token from the URL
// fragment for the legacy iframe deployment (no-op on bundled
// mobile); the second waits for `window.ReachyMini` to be defined,
// which on the bundled build happens synchronously at module load
// (see `./sdkBootstrap.ts`).

async function boot(): Promise<void> {
  consumeTokenFromHash();

  robot = new window.ReachyMini({
    appName: "Reachy Mini Mobile App",
    // No `clientId`: the SDK uses its own default, and the mobile
    // app handles HF OAuth itself via `useRemoteHfToken` /
    // `oauthLoopback` rather than letting the SDK initiate it.
    signalingUrl: CENTRAL_SIGNALING_URL,
    // Negotiate the audio tracks up front so the OpenAI Realtime
    // bridge has them ready when the user taps the orb to start
    // the conversation. Without this, the SDK doesn't open the
    // mic-side transceiver and `openaiBridge.getRobotMicTrack(robot)`
    // returns undefined when `runConversationParts()` runs.
    enableMicrophone: true,
  });
  // Hand the SDK ref to the session so its lifecycle methods
  // (start, release, reacquire, wakeUp, sleepAndDisable, attachVideo)
  // can use it. The engine's local `robot` closure stays in sync;
  // session is the canonical owner from here on.
  session.attachRobot(robot);
  wireRobotEvents({
    robot,
    session,
    isUnmounted: unmounted.get,
    renderRobotList,
    applyMicMuted,
    setState,
    onFatalError,
  });

  let authenticated = false;
  try {
    authenticated = await robot.authenticate();
  } catch (err) {
    // The HF hub SDK throws when it tries to read a cached token but cannot
    // resolve a clientId. Treat as "not signed in" rather than crashing the
    // app, and surface a helpful hint.
    console.warn("[main] authenticate() failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    if (/clientId/i.test(message) && onErrorMessageChange) {
      try {
        onErrorMessageChange("Add HF client ID in settings");
      } catch (callbackErr) {
        console.warn(
          "[conversation-engine] onErrorMessageChange threw:",
          callbackErr,
        );
      }
    }
  }

  if (authenticated) {
    setState("authenticated");

    // Mobile fast path: if the ConversePanel pre-fetched the robot's
    // central peer id for us (via /api/hf-auth/central-robot-status
    // on the daemon), drive the flow forward without a single tap.
    //
    // We drive `doConnect()` unconditionally whenever a robot is
    // preselected: that path only opens the SSE signaling channel
    // and the RTCPeerConnection / DataChannel (no OpenAI involvement),
    // and without that DataChannel the daemon proxy (`http_proxy`
    // over DC) is unreachable - the daemon-status pill, the wake /
    // sleep choreography, and the engine.bringup watchdog in
    // `useSessionController` would all stay stuck pending forever.
    // OpenAI Realtime credentials are minted lazily inside
    // `runConversationParts` (via `mintEphemeralKey`), so any
    // upstream failure there surfaces as a clean fall-back to
    // `ready` with a UI message - no need to gate the connect
    // step on it.
    if (preselectedRobotId) {
      // Awaited (no longer fire-and-forget): the unmount path uses
      // the parent boot promise as a "boot still in flight" guard
      // so it can wait for `doStart`'s `robot.startSession()` to
      // settle before calling `robot.stopSession()`. Without this
      // await, central races stopSession against startSession and
      // emits the "Session ended before it could start: unknown
      // reason" fatal that used to bite intermittent reconnects
      // (StrictMode double-mount, fast remounts, ...).
      //
      // `doConnect` swallows its own errors via `onFatalError`, so
      // awaiting here cannot throw; the promise simply resolves
      // once the WebRTC + wake-up dance is fully landed (or
      // failed).
      await doConnect();
    }
  } else {
    setState("signed-out");
  }
}

// HF user pill, avatar fetcher and the OIDC userinfo cache used to
// live here. The mobile app surfaces the signed-in identity in its
// own settings screen (see `RemoteSignInScreen`), so the engine
// stopped owning that surface.

// Paint the initial state onto the DOM before we hand control off to
// the SDK / boot pipeline. The FSM cursor is already initialised to
// `"connecting"` via `createEngineCore` above, but the subscribers
// we just wired never fire on creation - only on `set()`. On a slow
// first paint (SDK still loading, `authenticate()` not yet resolved)
// the host would otherwise see no initial transition for several
// seconds and the orb would keep the static markup's neutral
// `class="circle"`.
//
// Firing a no-op `set(current())` is what fans the initial value
// out to every subscriber (host `onStateChange`, motor mode sync)
// so the watchdog timers in `ConversePanel` arm right at mount,
// instead of waiting until `boot()` has run far enough to set its
// first explicit state.
fsm.set(fsm.current());

// The legacy "booting" class strip was tied to the engine's old
// inline markup (where the orb's `.ind` defaults clashed with the
// state-applied values, causing a fade-in on first paint). The
// React orb owns those transitions now, so the engine no longer
// touches `root` after mount.

/**
 * Captures the entire boot chain (`whenReachyReady → boot →
 * doConnect → doStart → robot.startSession + wake-up`) as a single
 * promise. `unmount()` awaits this (with a timeout) before tearing
 * down so we never call `robot.stopSession()` while
 * `robot.startSession()` is still mid-flight - that race is what
 * central reports as `Session ended before it could start: unknown
 * reason`.
 *
 * The chain swallows its own errors via `onFatalError`, so awaiting
 * it cannot throw. It resolves either:
 *   - successfully, once the wake-up dance has landed and the FSM
 *     is in `ready` (or further);
 *   - via `onFatalError`, which sets state to `error` and itself
 *     calls `teardown()` (idempotent against the unmount path -
 *     `teardown()` reads `wasSessionEstablished` once, and a second
 *     entry just re-disables motors / re-stops the conversation).
 */
const bootChain: Promise<void> = whenReachyReady()
  .then(async () => {
    if (unmounted.get()) return;
    await boot();
  })
  .catch((err) => {
    if (unmounted.get()) return;
    void onFatalError(err);
  });

// Background-tab + page-hide resilience. The module owns the listener
// install / dispose contract and the sendBeacon endSession path; the
// engine wires up the `onResume` callback with whatever the live
// session needs (resume audio analysers, probe the data channel).
// The keep-screen-on lock is owned by the host and isn't subject to
// visibility flips: iOS / Android release the OS idle-timer flag
// automatically when the app goes to background, and the
// `useKeepScreenOn` hook re-acquires it on the next render when
// the user returns and the relevant state is still active.
const disposeBackgroundResilience = installBackgroundResilience({
  getRobot: () => robot,
  centralSendUrl: `${CENTRAL_SIGNALING_URL}/send`,
  onResume: () => {
    if (
      fsm.current() === "listening" ||
      fsm.current() === "user-speaking" ||
      fsm.current() === "processing" ||
      fsm.current() === "ai-speaking"
    ) {
      resumeAudioContexts();
      void probeRobotLink();
    }
  },
});

// The 22-method `ConversationEngineHandle` lives in
// `./host-handle.ts`. Every method either delegates to one of the
// helpers we composed above (lifecycle entrypoints) or is a thin
// non-throwing wrapper around the SDK (volume getters/setters,
// `playSound`, `setHeadRpyDeg`, `subscribeLogs`, …). The handle
// holds no state of its own - everything it touches is read /
// written through the getters and setters in this deps object.
const handle: ConversationEngineHandle = createConversationHandle({
  getRobot: () => robot,
  clearRobot: () => {
    robot = null;
  },
  session,
  isUnmounted: unmounted.get,
  markUnmounted: unmounted.on,
  bootChain,
  disposeBackgroundResilience,
  disposeVision: () => {
    vision?.dispose();
  },
  isConversationStarted: conversationStarted.get,
  isConvoActiveRequested: convoActiveRequested.get,
  setConvoActiveRequested: convoActiveRequested.set,
  runConversationParts,
  tearDownConversationPipeline,
  teardown,
  applyMicMuted,
  handleHostStop,
  handleOrbClick,
  setState,
  emitConnectionAttempt,
  onFatalError,
  getMicLevel: audioMonitors.getMicLevel,
});
return handle;
} // end of mountConversation
