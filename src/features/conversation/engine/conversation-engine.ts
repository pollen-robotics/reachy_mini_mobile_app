/**
 * Reachy Mini · voice conversation engine.
 *
 * This file is the ORCHESTRATOR. It owns the conversation FSM and the
 * conversation pipeline (HF realtime, motion, tools, audio monitors),
 * and wires it to the `ConnectionController` (the transport layer:
 * SDK boot, WebRTC handshake, wake/sleep, the connection FSM). The two
 * sides are decoupled: they only talk through the lifecycle seam
 * (`onConnectionLive` / `onConnectionLost`), the `recordSend` feed, and
 * the `LiveSession` view of the live robot. The host-facing controls
 * (`handleOrbClick`, `handleHostStop`) live here and delegate transport
 * bits to the controller.
 *
 * Flow driven by a single central circle button:
 *
 *   signed-out  → click → robot.login()  (HF OAuth redirect)
 *   authenticated → click → session.ensureConnected() / robot.connect()
 *   connected  → select a robot ⇒ ready
 *   ready      → click → session.start() + session.wakeUp() +
 *                        HF realtime WebSocket
 *   streaming  (listening / user-speaking / ai-speaking)
 *
 * Audio routing (robot = hub):
 *   robot mic track (received on robot._pc) ─▶ HF realtime input PCM
 *   HF output PCM track                     ─▶ robot audio sender (replaceTrack)
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
 *     conversation-engine.ts   ← THIS FILE. Conversation FSM, mount
 *                              lifecycle, the conversation pipeline
 *                              (runConversationParts /
 *                              tearDownConversationPipeline) and the
 *                              wiring that composes everything below.
 *     connection-controller.ts The TRANSPORT layer: SDK robot ref,
 *                              connection FSM (boot / doConnect /
 *                              doStart / teardown / renderRobotList),
 *                              dc-health, motor-mode sync, SDK event
 *                              wiring, background-tab resilience.
 *     conversation-error.ts    Shared realtime-failure → caption mapper.
 *     types.ts                 Public types (Handle, FSM states, …).
 *     settings.ts              Realtime voice / prompt defaults.
 *     memory.ts                Long-term memory (`remember` tool).
 *     audioLevelMonitor.ts     `MicLevelMonitor` + `AiLevelMonitor`
 *                              classes driving the orb visuals.
 *     audio-monitors-control.ts Engine-side wrapper over the two
 *                              monitor classes: lazy instantiation,
 *                              cached mic level, `waitForAiSilence`
 *                              fallback, audio-context resume.
 *     release-sdk-phone-mic.ts Releases the iOS phone-mic claim
 *                              after the realtime bridge has swapped
 *                              the WebRTC sender's track.
 *     robot-events.ts          SDK `addEventListener` wiring
 *                              (probes, robotsChanged, sessionStopped,
 *                              videoTrack, disconnected, error).
 *     host-handle.ts           `ConversationEngineHandle` factory:
 *                              every method the React host calls
 *                              (lifecycle, volume, joystick, …).
 *     trajectoryGate.ts        Daemon-trajectory yield flag.
 *     tools.ts                 Realtime tool descriptors + head poses.
 *
 *     bridge/huggingface-bridge.ts
 *                              HF realtime client lifecycle:
 *                              WebSocket handshake, audio sink, output
 *                              track routing to the robot speaker,
 *                              silent one-shot reconnect.
 *
 *     motion-control/
 *       wobbler-control.ts     `HeadWobbler` lifecycle + gates.
 *       antennas-control.ts    `AntennasOscillator` lifecycle.
 *       pose-dispatcher.ts     30 Hz coalescing tick to the daemon.
 *
 *     tools/
 *       tool-call-handler.ts   Realtime tool dispatch (move_head,
 *                              play_move, remember, forget) + lazy
 *                              `MovePlayer` + pose-restore timer.
 */

// Side-effect import: attaches the bundled SDK to `window.ReachyMini`
// and dispatches `reachymini:ready` so the engine's CDN-style waiter
// (`whenReachyReady()`) resolves immediately. Without this the engine
// sits forever in `connecting`, waiting for a global that no <script>
// tag will ever set in the bundled mobile build.
import "@/features/robot-session/sdk-bootstrap";

import type { RobotInfo } from "@/features/robot-session/sdk-types";
import {
  createBackgroundAudioKeeper,
  type BackgroundAudioKeeper,
} from "../background-audio-keeper";
import { createAudioMonitorsControl } from "./audio-monitors-control";
import { loadSettings, type Settings } from "./settings";
import { readHfTokenFromStorage } from "./hf-token";
import { memoryStore } from "./memory";
import { getActivePersonality, resolvePersonaVoice } from "@/features/personalities";
import { RobotSession } from "@/features/robot-session/RobotSession";
import {
  createLiveSession,
  type LiveSession,
} from "@/features/robot-session/live-session";
import { createToolCallHandler } from "./tools/tool-call-handler";
import { createMotionOrchestrator } from "./motion-control/orchestrator";
import {
  createRealtimeBackendController,
  type RealtimeBackendController,
} from "./realtime/backend-controller";
import type { RealtimeBackendDeps } from "./realtime/types";
import { attachVision, getVisionPromptAppendix } from "../vision";
import {
  getActiveLanguageId,
  getLanguagePromptAppendix,
} from "../../conversation-language";
import {
  isMemoryEnabled,
  isVisionEnabled,
} from "../../conversation-settings";
import { ROBOT_TOOLS } from "./tools";
import { releaseSdkPhoneMic } from "./release-sdk-phone-mic";
import { createConversationHandle } from "./host-handle";
import { createEngineCore } from "./engine-core";
import { formatConversationError } from "./conversation-error";
import {
  createConnectionController,
  type ConnectionController,
} from "./connection-controller";
import type {
  ConnectionState,
  ConversationState,
  ConversationBringUpPhase,
  ConversationConnectionAttempt,
  ConversationEngineHandle,
  ConversationEngineOptions,
  ConversationToolToastEvent,
  ConversationTransportInfo,
} from "./types";

// Public-types re-exports so the prior import path keeps working.
// New code should pull these straight from `./types`.
export type {
  ConnectionState,
  ConversationBringUpPhase,
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
const getRobotHardwareId = (): string | null => {
  const value = options.getRobotHardwareId?.();
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

// Optional external state observers (mobile-side watchdog + orb).
// `onConnectionStateChange` fires once per CONNECTION transition,
// `onConversationStateChange` once per CONVERSATION transition. Fired
// from inside the matching FSM's subscriber. We never touch them after
// the mount returns - the consumer disposes by unmounting the engine.
const onConnectionStateChange: ((state: ConnectionState) => void) | null =
  typeof options.onConnectionStateChange === "function"
    ? options.onConnectionStateChange
    : null;
const onConversationStateChange: ((state: ConversationState) => void) | null =
  typeof options.onConversationStateChange === "function"
    ? options.onConversationStateChange
    : null;

// Optional external observer for the live WebRTC transport (active ICE
// candidate-pair classification + instantaneous bitrate). Fired by the
// `TransportMonitor` owned by `RobotSession`. The mobile app renders a
// "kind + bitrate" badge in the session topbar from this signal.
//
// Lifecycle-wise the monitor follows the SESSION PC (layer C), NOT the
// conversation pipeline (layer D): the badge is therefore active any
// time the SDK pc is up, regardless of whether the HF realtime
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

const onDaemonVersionChange: ((version: string | null) => void) | null =
  typeof options.onDaemonVersionChange === "function"
    ? options.onDaemonVersionChange
    : null;

const emitDaemonVersion = (version: string | null): void => {
  if (!onDaemonVersionChange) return;
  try {
    onDaemonVersionChange(version);
  } catch (err) {
    console.warn("[conversation-engine] onDaemonVersionChange threw:", err);
  }
};

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

const onBringUpPhase: ((phase: ConversationBringUpPhase | null) => void) | null =
  typeof options.onBringUpPhase === "function"
    ? options.onBringUpPhase
    : null;

const emitBringUpPhase = (phase: ConversationBringUpPhase | null): void => {
  if (!onBringUpPhase) return;
  try {
    onBringUpPhase(phase);
  } catch (err) {
    console.warn("[engine] onBringUpPhase callback threw:", err);
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
// antennas / backend / wobbler stay quiet until the user explicitly
// hits "Start conversation".
const core = createEngineCore({
  initialConnectionState: "connecting",
  convoActiveRequested: options.autoStartConversation !== false,
});
const { connection, conversation } = core;
const { conversationStarted, convoActiveRequested, unmounted, movePlaying } =
  core.gates;
// Terse aliases for the two FSM cursors. `setConnectionState` drives
// the transport machine (connecting → live → released …);
// `setConversationState` drives the AI pipeline machine (idle →
// starting → listening …). Each owns its cursor + subscriber fan-out.
const setConnectionState = connection.set;
const setConversationState = conversation.set;

// Settings, defaults, tool descriptors and head-pose lookup
// table all live in their own modules now to keep this file focused
// on the FSM + orchestration:
//   - `./settings.ts` → `Settings`, `loadSettings()`, defaults, storage keys
//   - `./tools.ts`    → `ROBOT_TOOLS`, `HEAD_POSES`, `HeadPoseName`

// ─── State machines ─────────────────────────────────────────────────────
// `ConnectionState` + `ConversationState` are defined in `./types` so
// `ConversationEngineOptions.onConnectionStateChange` /
// `onConversationStateChange` can reference them. The two FSMs live on
// `core` (see above); this closure drives them through
// `setConnectionState` / `setConversationState`.

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

// The SDK robot ref now lives in the `ConnectionController` (created
// below). The conversation pipeline never touches it directly: it
// reads the live robot through the `liveSession` transport seam, and
// the host handle reads it through `connectionController.getRobot()`.

// Realtime backend lifecycle is owned by the `RealtimeBackendController`
// (see `./realtime/backend-controller.ts`): it holds the live
// provider-specific bridge (client + audio sink + reconnect counters +
// reconnecting flag), the vision side-channel wired onto that bridge,
// and swaps both when the user picks a different provider in the
// settings. The engine just observes the bridge's events and drives the
// FSM + motion controllers in reaction.
//
// Declared as `let | null` because `toolCallHandler` is created EARLIER
// in the closure (it has no dependency on the bridge) yet needs to
// forward `sendToolResponse` / `look` calls at runtime. The late `=`
// assignment below resolves the cycle without forward declarations or
// class wrappers; the handlers read `backend?.bridge()` / `backend?.vision()`
// lazily so the null window before assignment degrades to a no-op.
let backend: RealtimeBackendController | null = null;

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
// custom properties from the inbound mic / assistant output tracks,
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
// Narrow transport capability the conversation pipeline (motion,
// tools, realtime backend, vision) consumes. It never reaches into
// `RobotSession` or the SDK ref directly - the `ConnectionController`
// owns WHEN a robot is live; this view exposes only `getRobot` /
// `getVideoStream`. The seam the conversation pipeline depends on
// instead of the connection layer's internals.
const liveSession: LiveSession = createLiveSession(session);
// Wire the host's transport listener once. The class owns all the
// start/stop bookkeeping internally so the monitor follows the
// session pc lifecycle (`start` / `reacquire` / `stop` / `release` /
// `detachRobot`) without the conversation engine having to know
// anything about candidate pairs.
session.setTransportListener(onTransportChange);
// Wire the live peer-id re-resolver so every bring-up dials the CURRENT
// producer instead of a stale snapshot (the robot's peer id rotates on
// each relay reconnect). No-op when the host didn't supply one.
session.setResolvePeerId(
  typeof options.resolvePeerId === "function" ? options.resolvePeerId : null,
);

// Reconnect bookkeeping (attempt counter + in-flight flag) is owned
// by the realtime bridge. The engine reads it through
// `backend.bridge().isReconnecting()` for the few sites that need it.

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

// 1. Host-facing state observers (React mobile shell, watchdog timers,
//    test loggers). One per FSM. Each FSM already logs the transition
//    itself via its `label` in `createEngineCore`, so we don't
//    duplicate that here.
if (onConnectionStateChange) {
  connection.subscribe((next) => {
    try {
      onConnectionStateChange(next);
    } catch (err) {
      console.warn("[conversation-engine] onConnectionStateChange threw:", err);
    }
  });
}
if (onConversationStateChange) {
  conversation.subscribe((next) => {
    try {
      onConversationStateChange(next);
    } catch (err) {
      console.warn(
        "[conversation-engine] onConversationStateChange threw:",
        err,
      );
    }
  });
}

// 2. Error-message clearing on leave-error. The host typically renders
//    a small caption / tooltip under the orb when in `error`; we drop
//    it as soon as the user navigates away (e.g. tapping retry takes
//    us back to `authenticated`). `error` is a CONNECTION state.
if (onErrorMessageChange) {
  connection.subscribe((next, prev) => {
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

function emitErrorMessage(message: string | null): void {
  if (!onErrorMessageChange) return;
  try {
    onErrorMessageChange(message);
  } catch (err) {
    console.warn("[conversation-engine] onErrorMessageChange threw:", err);
  }
}

// 3. Daemon-side motor mode dedup. The `ConnectionController` (created
//    just below) subscribes the motor-mode sync to BOTH FSMs. It is
//    instantiated AFTER the host-facing observers above so the
//    user-visible transition is already fanned out by the time the
//    motor-mode write hits the DataChannel.

// ─── Connection controller (transport layer) ────────────────────────────
//
// Owns the SDK robot ref, the connection FSM transitions
// (boot → doConnect → doStart → live), the data-channel health
// monitor, the motor-mode sync and the SDK event wiring. It talks to
// the conversation pipeline below ONLY through the lifecycle seam
// (`onConnectionLive` / `onConnectionLost`) plus the `recordSend`
// feed; the conversation side reads the live robot through
// `liveSession`. The hooks passed here are hoisted function
// declarations defined further down in this orchestrator.
const connectionController: ConnectionController = createConnectionController({
  core,
  session,
  preselectedRobotId,
  shouldDeferInitialWakeUp: options.shouldDeferInitialWakeUp,
  emitConnectionAttempt,
  emitBringUpPhase,
  emitErrorMessage,
  emitDaemonVersion,
  onConnectionLive: () => onConnectionLive(),
  onConnectionLost: (opts) => onConnectionLost(opts),
  resumeAudioContexts: () => resumeAudioContexts(),
  applyMicMuted: (muted) => applyMicMuted(muted),
  // Deferred through a closure: `motion` is created further down (the
  // orchestrator needs `recordSend`, which the controller provides),
  // and the gate only fires on SDK resilience events long after boot.
  setPoseSendGate: (gated) => motion.setSendGate(gated),
});

// Motion's pose dispatcher feeds the controller's data-channel health
// monitor through this sink (a failed-send streak escalates to a fatal
// link error → full teardown).
const recordSend = connectionController.recordSend;

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
    const robot = connectionController.getRobot();
    switch (connection.current()) {
      case "signed-out":
        if (!robot) return;
        await robot.login();
        return;

      case "authenticated":
        await connectionController.connect();
        return;

      case "live":
        // SDK + DataChannel are up, the robot has woken and motors
        // are enabled. A tap only means "start the AI side" when no
        // conversation is running yet (conversation idle); ignore taps
        // while a conversation is already live / winding down.
        if (conversation.current() !== "idle") return;
        // Flip `convoActiveRequested` so re-entries do not bounce back
        // to idle if the runner is interrupted, and run the
        // conversation pipeline (HF backend handshake, audio pumps,
        // motion modules). `runConversationParts` itself sets the
        // conversation FSM to `starting` to keep the orb honest.
        convoActiveRequested.on();
        await runConversationParts();
        return;

      case "error":
        session.setSelectedRobotId(null);
        if (robot?.isAuthenticated) {
          setConnectionState("authenticated");
        } else {
          setConnectionState("signed-out");
        }
        return;

      default:
        return;
    }
  } catch (err) {
    connectionController.onFatalError(err);
  }
}

function applyMicMuted(next: boolean): void {
  // Mute = gate the robot's mic track we forward to the HF backend, so the
  // assistant stops HEARING the user (matches the MicOff button).
  //
  // This goes through the bridge, NOT `robot.setMicMuted()`: since
  // SDK 1.8.0 the SDK no longer owns a getUserMedia stream, so its
  // `setMicMuted` is a silent no-op (it gates a null `_micStream`).
  // The bridge owns the robot-mic→backend routing, so the gate lives
  // there and survives transparent reconnects.
  try {
    backend?.bridge().setMicMuted(next);
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
  await connectionController.teardown();
  session.setSelectedRobotId(null);
  applyMicMuted(false);
  const robot = connectionController.getRobot();
  // `teardown()` already parked the conversation FSM on `idle`; here we
  // re-park the connection FSM on the closest sensible resting state.
  if (!robot) {
    setConnectionState("signed-out");
  } else if (robot.state !== "disconnected") {
    setConnectionState("connected");
    connectionController.renderRobotList(
      session.getKnownRobots() as RobotInfo[],
    );
  } else if (robot.isAuthenticated) {
    setConnectionState("authenticated");
  } else {
    setConnectionState("signed-out");
  }
}

// ─── Conversation pipeline (D layer) ────────────────────────────────────

/**
 * Conversation-layer reaction to the connection reaching `live`.
 *
 * This is the connection → conversation seam (the future
 * `ConversationController` will own it). The connection bring-up
 * (`doStart`) calls this the moment the transport is live; we decide
 * HERE whether to bring the AI pipeline up:
 *
 *   - host already opted in (`convoActiveRequested`) → run the
 *     conversation parts now;
 *   - otherwise park on a live connection with the conversation FSM
 *     still `idle` so the host renders the orb's "press to start"
 *     affordance. The user's tap routes through `handleOrbClick`
 *     (connection `live` + conversation `idle`) back into
 *     `runConversationParts()`.
 */
async function onConnectionLive(): Promise<void> {
  if (!convoActiveRequested.get()) return;
  await runConversationParts();
}

/**
 * The conversation pipeline proper: antenna oscillator, head wobbler,
 * HF realtime client, mic plumbing. Split out of `doStart` so the
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
  // The conversation pipeline depends ONLY on the transport seam
  // (`LiveSession`), never on the connection layer's `robot` ref.
  // Snapshot it once: if it's null the connection isn't live, so
  // there's nothing to bring up.
  const robot = liveSession.getRobot();
  if (!robot || conversationStarted.get()) return;

  emitErrorMessage(null);
  conversationStarted.on();

  // Arm the conversation `starting` state before the HF backend
  // handshake so the orb flips to its connecting spinner the instant
  // the user taps. The connection FSM is already `live` here (both the
  // deferred tap-to-start path and the auto-start path reach this after
  // `setConnectionState("live")` in `doStart`).
  setConversationState("starting");

  if (unmounted.get()) {
    conversationStarted.off();
    return;
  }

  // Grab the robot's incoming audio track (the robot's microphone).
  const robotMicTrack = backend?.bridge().getRobotMicTrack(robot) ?? null;
  if (!robotMicTrack) {
    conversationStarted.off();
    connectionController.onFatalError(
      new Error("Could not find the robot's microphone track"),
    );
    return;
  }

  audioMonitors.startMic(robotMicTrack);

  // ─── TEMP MIC DIAGNOSTIC (remove once the no-input bug is solved) ──
  // Answers one question: does the robot's *remote* audio track deliver
  // RTP audio into this client? If `bytes`/`delta` grow while you speak
  // near the robot, the daemon IS sending audio and the problem is the
  // client reading it (WKWebView WebAudio on a remote track). If they
  // stay flat, the daemon isn't transmitting mic audio on this peer.
  // Read it in the app's devtools console, filter on "[MIC-DIAG]".
  try {
    const w = window as unknown as Record<string, unknown>;
    const prevTimer = w.__micDiagTimer as ReturnType<typeof setInterval> | undefined;
    if (prevTimer) clearInterval(prevTimer);
    w.__robotPc = robot._pc;
    w.__robotMicTrack = robotMicTrack;
    console.info("[MIC-DIAG] robot mic track:", {
      id: robotMicTrack.id,
      enabled: robotMicTrack.enabled,
      muted: robotMicTrack.muted,
      readyState: robotMicTrack.readyState,
    });
    let lastBytes = 0;
    w.__micDiagTimer = setInterval(() => {
      const pc = robot?._pc;
      if (!pc) return;
      void pc.getStats().then((stats) => {
        stats.forEach((report) => {
          const r = report as unknown as Record<string, unknown>;
          if (r.type === "inbound-rtp" && r.kind === "audio") {
            const bytes = Number(r.bytesReceived ?? 0);
            const delta = bytes - lastBytes;
            lastBytes = bytes;
            console.info(
              "[MIC-DIAG] inbound audio",
              "bytes=", bytes,
              "delta=", delta,
              "packets=", r.packetsReceived,
              "audioLevel=", r.audioLevel,
              "trackMuted=", robotMicTrack.muted,
              "readyState=", robotMicTrack.readyState,
            );
          }
        });
      });
    }, 1500);
  } catch (err) {
    console.warn("[MIC-DIAG] setup failed", err);
  }

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
  backend?.bridge().resetReconnectCounter();
  try {
    await backend?.bridge().connect(robotMicTrack);
  } catch (err) {
    await recoverConversationStartFailure(err);
    return;
  }

  // Vision is on-demand only (the `look` tool) - there is nothing to
  // start here. The tool is gated on `isVisionEnabled()` at prompt /
  // tool-list build time (see `composeInstructions` / `tools` below),
  // so when scene-awareness is off the model never gets the `look`
  // tool and no frame is ever captured.

  // Every fresh conversation starts unmuted. Routed through the bridge
  // (not the inert SDK `setMicMuted`) so it also clears any mute state
  // a previous session left on the bridge — a new session must never
  // inherit a stale mute. Transparent reconnects, by contrast, go
  // through `bridge.connect()` which re-applies the live mute state.
  backend?.bridge().setMicMuted(false);

  // Release the iOS phone-microphone claim now that the bridge has
  // replaced the SDK's outgoing audio sender with the assistant output
  // track.
  //
  // Background. The vendored SDK calls `getUserMedia({audio:true})`
  // during `startSession()` (`_enableMicrophone: true`) and stashes
  // the resulting MediaStream as `_micStream`, then attaches its
  // tracks to the WebRTC `_pc` as audio senders. Even though we
  // immediately swap those senders' tracks for the assistant output via
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
  // the bridge already swapped it for the assistant track above; the
  // tracks we're stopping are dangling references the SDK no
  // longer pumps data into. Idempotent against subsequent
  // `runConversationParts()` calls (a re-acquire after release):
  // the SDK regenerates `_micStream` on every `startSession`, so
  // this stop runs exactly once per session.
  releaseSdkPhoneMic(robot);
}

async function recoverConversationStartFailure(err: unknown): Promise<void> {
  const detail = err instanceof Error ? err.message : String(err);
  // Log the raw detail (allocator HTTP status / websocket close code+reason)
  // so a prod failure is diagnosable from a single greppable line, even
  // though the user only sees the friendly classification below.
  console.warn("[conversation-engine] HF realtime startup failed:", detail);
  emitErrorMessage(formatConversationError(detail));
  await tearDownConversationPipeline({ glide: true });
  if (!unmounted.get() && session.isEstablished()) {
    // Transport stays `live`; just drop the conversation back to idle
    // so the orb returns to its "tap to start" affordance.
    setConversationState("idle");
  }
}

// ─── Tool-call handler ─────────────────────────────────────────────────
//
// `tools/tool-call-handler.ts` owns the realtime tool-call dispatch
// (`move_head`, `play_move`, `remember`, `forget`), the lazily-created
// `MovePlayer`, and the head-pose restore timer. We feed it the
// engine state it needs through getters and listen to its
// `onMoveStart` / `onMoveEnd` callbacks so the wobbler + antennas
// pause cleanly during a choreography.

const toolCallHandler = createToolCallHandler({
  getRobot: liveSession.getRobot,
  // Late-bound through the bridge variable below: the bridge is
  // created AFTER this handler so we can pass `handleToolCall` into
  // its `onToolCall` deps without a circular reference. The `?? false`
  // guard covers the brief window between the engine starting and
  // the bridge being assigned (during which a tool call cannot
  // realistically happen anyway), plus the post-teardown window
  // after `unmount()`.
  sendToolResponse: (callId, result) =>
    backend?.bridge().sendToolResponse(callId, result) ?? false,
  onMoveStart: () => {
    movePlaying.on();
  },
  onMoveEnd: () => {
    movePlaying.off();
  },
  // Coerce `null` (engine convention for "no observer") to `undefined`
  // (handler convention from the optional callback shape).
  onToolToast: onToolToast ?? undefined,
  // Late-bound onto the `vision` handle declared further down (same
  // forward-reference pattern as the bridge): the `look` tool calls
  // through here. When vision is inert (no HF token) `vision` is null
  // and we return a graceful "unavailable" result rather than throw.
  look: () =>
    backend?.vision()?.look() ??
    Promise.resolve({
      ok: false,
      message: "vision is not available in this session",
    }),
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
// from the `ConnectionController` (`installBackgroundResilience()`),
// which wires this `resumeAudioContexts` hook for the audio-context
// resume on visibility return.

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
  getRobot: liveSession.getRobot,
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

// ─── Hugging Face realtime bridge ──────────────────────────────────────
//
// `bridge/huggingface-bridge.ts` owns the realtime backend session:
//   - Client construction + WebSocket handshake
//   - Routing the AI output track to the robot's audio sender
//   - Hidden `<audio>` sink so browsers actually pump the generated track
//   - One-shot transparent reconnect on transient errors
//   - Mic-track lookup helper
//
// The engine reacts to its events (`onStatus`, `onOutputTrack`,
// `onToolCall`, `onReconnecting`, `onFatalError`) by driving the FSM,
// motion controllers and audio analysers. The bridge itself stays
// blissfully unaware of any of that.

const realtimeBackendDeps: RealtimeBackendDeps = {
  getRobot: liveSession.getRobot,
  getRobotHardwareId,
  // Resolve the voice lazily (re-read on every `buildClient()` so a
  // personality switch picks up the right voice on the next reconnect,
  // without rebuilding the bridge). `resolvePersonaVoice` snaps the
  // persona's voice onto the HF catalog (falling back to the default
  // for a stale/unknown id).
  voice: () => {
    const personality = getActivePersonality();
    return resolvePersonaVoice(personality.voice);
  },
  // Keep the input transcriber's language in sync with the app-wide
  // conversation-language preference (same id used for the prompt
  // appendix below). Resolved lazily so a language switch is applied
  // on the next connect / reconnect.
  transcriptionLanguage: () => getActiveLanguageId(),
  composeInstructions: () => {
    // Snapshot the user's long-term memory ONCE per connection. We
    // intentionally don't push live updates to the realtime session: a
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
  tools: () => {
    // Drop tools whose backing feature is off this session so the
    // model isn't primed to call a capability it doesn't have:
    //   - memory off → no `remember` / `forget`
    //   - vision off → no `look` (camera is never read)
    let list = ROBOT_TOOLS;
    if (!isMemoryEnabled())
      list = list.filter((t) => t.name !== "remember" && t.name !== "forget");
    if (!isVisionEnabled()) list = list.filter((t) => t.name !== "look");
    return list;
  },
  onStatus: (status) => {
    // Once the user has tapped stop we park the orb in `stopping`
    // (spinner) and run a gentle ~700 ms teardown. The HF bridge
    // can still emit a trailing status as it closes (a final
    // `connected` from the in-flight response completing, or a late
    // activity flip) which would otherwise call
    // `setConversationState("listening")` below and yank the orb
    // straight back into a live look, swallowing the "ending" spinner.
    // Ignore status events while we are deliberately winding down.
    if (conversation.current() === "stopping") return;
    switch (status) {
      case "connected":
        // The websocket backend marks `connected` after its queued
        // PCM output has drained. We still use the analyser as a
        // precise tail-end probe so the orb does not snap back to
        // listening while Reachy's speaker is finishing the last
        // syllable.
        if (conversation.current() === "ai-speaking") {
          audioMonitors.waitForAiSilence(400, () => {
            // Another event may have moved us elsewhere in the
            // meantime (user barge-in, error, teardown). Only
            // transition if we're still the ones holding the mic.
            if (conversation.current() === "ai-speaking") {
              setConversationState("listening");
              motion.onListening();
            }
          });
        } else {
          setConversationState("listening");
          motion.onListening();
        }
        break;
      case "user-speaking":
        // Barge-in: cancel any queued "back to listening" from a
        // previous response so it doesn't overwrite the new state a
        // few hundred ms after the user started talking.
        audioMonitors.cancelAiSilenceWait();
        setConversationState("user-speaking");
        motion.onUserSpeak();
        break;
      case "processing":
        setConversationState("processing");
        motion.onProcessing();
        break;
      case "ai-speaking":
        audioMonitors.cancelAiSilenceWait();
        setConversationState("ai-speaking");
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
    // The bridge is rebuilding the realtime backend connection. Pause motion
    // (their input track is about to go away) and drop the orb
    // back to a transient conversation "starting" visual.
    setConversationState("starting");
    motion.onReconnecting();
  },
  onFatalError: (err) => {
    void connectionController.onFatalError(err);
  },
};

// ─── Realtime backend controller ───────────────────────────────────────
//
// Owns the live Hugging Face realtime bridge AND the vision side-channel
// wired onto it. The bridge is built once here (there is a single
// realtime backend); the lazily-read voice / prompt / tools let a
// personality, language or tool change apply on the next conversation
// start without rebuilding it.
//
// Vision side-channel (see `docs/VISION.md`)
// ──────────────────────────────────────────
// On-demand scene awareness: the camera is read ONLY when the model
// calls the `look` tool (no passive/periodic capture). The result is
// mirrored into the realtime context as a `<scene_observation>` block.
// `attachVision` returns null when no HF token is available, and every
// call site degrades to a no-op via optional chaining. Vision lives on
// the bridge's `RealtimePort`; the controller keeps the build + attach
// in one place so the engine can't forget to wire it.
//
// The VLM provider (`vision/providers/hf-vlm-provider.ts`) hits Hugging
// Face's Inference Providers router with the USER'S OWN HF token (the
// same token in `sessionStorage.hf_token` used by the realtime
// allocator), deliberately decoupling vision from the voice pipeline:
//   - no master model-provider key on the wire (no server-side proxy, no shared bill);
//   - per-user billing (each user's calls land on their own HF tier);
//   - changing the VLM model is a one-line edit in `vision/config.ts`.
backend = createRealtimeBackendController({
  bridgeDeps: realtimeBackendDeps,
  attachVision: (bridge) =>
    attachVision({
      realtime: bridge.getRealtimePort(),
      getVideoStream: liveSession.getVideoStream,
      getHfToken: readHfTokenFromStorage,
    }),
});

/**
 * Common tear-down of the conversation pipeline (D layer).
 *
 * Three orchestration paths all need to stop the tool-call handler,
 * antennas / wobbler, realtime bridge, pose dispatcher, audio monitors
 * and background audio keeper in the exact same order:
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
 *   3. close the realtime bridge (awaited in parallel with the glide
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

  // Vision has no per-conversation lifecycle (on-demand `look` only),
  // so nothing to stop here; it's released for good in `unmount`.
  toolCallHandler.stop();
  movePlaying.off();

  // Tear the motion stack down. `glide: true` plays a 700 ms
  // ease-out to neutral in parallel with the realtime bridge close
  // so the next bring-up (or the iframe handover) inherits a
  // calmly-posed robot. `glide: false` is the power-off path:
  // `gotoSleep` is about to own the head + antennas trajectory
  // and any glide frame here would just fight the daemon-side
  // sleep animation. The orchestrator stops the dispatcher last,
  // after the glide + bridge close have settled.
  await motion.stop({
    glide,
    concurrentTask: backend?.bridge().close(),
  });
  backend?.bridge().resetReconnectCounter();

  audioMonitors.stopMic();
  audioMonitors.stopAi();
  // Drop the keepalive AudioContext so iOS lets the audio session
  // revert to `Ambient` and we go back to plain foreground-only
  // behaviour. Safe to call when not running.
  backgroundAudioKeeper.stop();

  // Mute the robot mic so any in-flight audio frames don't leak
  // through to the speakers while the realtime client is gone. Safe
  // on the power-off path too - the session is about to be torn
  // down anyway; `handleHostStop` unmutes again after `teardown()`
  // returns when it's a stop-not-power-off.
  try {
    liveSession.getRobot()?.setMicMuted(true);
  } catch {
    // ignored
  }

  conversationStarted.off();
}

/**
 * Conversation-layer reaction to the connection going down.
 *
 * The connection → conversation seam's teardown half (mirror of
 * `onConnectionLive`). The connection teardown calls this so it
 * never has to know about the conversation pipeline internals: tear
 * the AI pipeline (`glide:false` on the power-off path where
 * `gotoSleep` owns the head trajectory) and drop the conversation
 * FSM to `idle`, so every teardown caller inherits a clean
 * conversation cursor.
 */
async function onConnectionLost({ glide }: { glide: boolean }): Promise<void> {
  await tearDownConversationPipeline({ glide });
  setConversationState("idle");
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
// out to every subscriber (host `onConnectionStateChange`, motor mode
// sync) so the watchdog timers in `ConversePanel` arm right at mount,
// instead of waiting until `boot()` has run far enough to set its
// first explicit state. The conversation FSM starts `idle` and the
// host initialises to the same value, so no initial paint is needed
// on that side.
connection.set(connection.current());

// The legacy "booting" class strip was tied to the engine's old
// inline markup (where the orb's `.ind` defaults clashed with the
// state-applied values, causing a fade-in on first paint). The
// React orb owns those transitions now, so the engine no longer
// touches `root` after mount.

// Kick the boot chain and install background-tab resilience now that
// the conversation pipeline is fully wired. `connectionController.start()`
// owns the chain (`whenReachyReady → boot → doConnect → doStart →
// live`) and the visibility / page-hide listeners (which re-arm a
// dropped session and resume the conversation's audio contexts via the
// `resumeAudioContexts` hook). We keep its two return values for the
// unmount path: `bootChain` is awaited (with a timeout) before
// `stopSession()` so we never tear down mid-`startSession`, and
// `disposeBackgroundResilience` removes the listeners on unmount.
const { bootChain, disposeBackgroundResilience } =
  connectionController.start();

// The 22-method `ConversationEngineHandle` lives in
// `./host-handle.ts`. Every method either delegates to one of the
// helpers we composed above (lifecycle entrypoints) or is a thin
// non-throwing wrapper around the SDK (volume getters/setters,
// `playSound`, `setHeadRpyDeg`, `subscribeLogs`, …). The handle
// holds no state of its own - everything it touches is read /
// written through the getters and setters in this deps object.
const handle: ConversationEngineHandle = createConversationHandle({
  getRobot: connectionController.getRobot,
  clearRobot: connectionController.clearRobot,
  session,
  isUnmounted: unmounted.get,
  markUnmounted: unmounted.on,
  bootChain,
  disposeBackgroundResilience,
  disposeVision: () => {
    backend?.disposeVision();
  },
  isConversationStarted: conversationStarted.get,
  isConvoActiveRequested: convoActiveRequested.get,
  setConvoActiveRequested: convoActiveRequested.set,
  runConversationParts,
  tearDownConversationPipeline,
  teardown: connectionController.teardown,
  applyMicMuted,
  handleHostStop,
  handleOrbClick,
  setConnectionState,
  setConversationState,
  emitConnectionAttempt,
  onFatalError: connectionController.onFatalError,
  getMicLevel: audioMonitors.getMicLevel,
});
return handle;
} // end of mountConversation
