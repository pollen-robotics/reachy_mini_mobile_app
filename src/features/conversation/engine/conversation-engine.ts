/**
 * Reachy Mini · voice conversation engine.
 *
 * This file is the ORCHESTRATOR. It owns the two state machines
 * (connection + conversation) and wires the `ConnectionController` (the
 * transport layer: SDK boot, WebRTC handshake, wake/sleep) to the
 * conversation, which runs ON THE ROBOT in the conversation app and is
 * started and observed over JSON-RPC (see
 * `features/conv-app/robot-conversation.ts`). The phone no longer touches
 * audio or motion: it starts the app through the daemon, follows its turn
 * events into the conversation FSM, and stops it again.
 *
 * Flow driven by a single central circle button:
 *
 *   signed-out    → tap → robot.login()  (HF OAuth redirect)
 *   authenticated → tap → connect (SDK session + DataChannel, wake-up)
 *   live + idle   → tap → apps.start on the robot, follow conversation.*
 *   listening / user-speaking / processing / ai-speaking ← robot turn events
 *
 * Layered architecture
 * ────────────────────
 *
 *   features/robot-session/       SESSION layer: `RobotSession`, the SDK
 *                                 bring-up helpers, dc-health, transport
 *                                 monitor, background resilience, the
 *                                 `ReachyMiniInstance` shape.
 *   features/conv-app/            The robot-side conversation: typed
 *                                 JSON-RPC client + `RobotConversation`.
 *   features/conversation/engine/ ← THIS layer.
 *     conversation-engine.ts      Orchestrator (this file).
 *     connection-controller.ts    Transport: SDK robot ref, connection FSM
 *                                 (boot / connect / start / teardown),
 *                                 dc-health, motor-mode sync, SDK events.
 *     audio-startup-config.ts     XVF3800 tuning applied at bring-up.
 *     robot-events.ts             SDK `addEventListener` wiring.
 *     host-handle.ts              `ConversationEngineHandle` factory: every
 *                                 method the React host calls.
 *     engine-core/                The two FSMs + the boolean gates.
 *     conversation-error.ts       Transport-failure → caption mapper.
 *     types.ts                    Public types (Handle, FSM states, …).
 */

// Side-effect import: attaches the bundled SDK to `window.ReachyMini`
// and dispatches `reachymini:ready` so the engine's CDN-style waiter
// (`whenReachyReady()`) resolves immediately. Without this the engine
// sits forever in `connecting`, waiting for a global that no <script>
// tag will ever set in the bundled mobile build.
import "@/features/robot-session/sdk-bootstrap";

import type { RobotInfo } from "@/features/robot-session/sdk-types";
import { RobotSession } from "@/features/robot-session/RobotSession";
import {
  createLiveSession,
  type LiveSession,
} from "@/features/robot-session/live-session";
import { createConversationHandle } from "./host-handle";
import { createRobotConversation } from "@/features/conv-app/robot-conversation";
import { createEngineCore } from "./engine-core";
import {
  createConnectionController,
  type ConnectionController,
} from "./connection-controller";
import type {
  ConnectionState,
  ConversationLevelEvent,
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

// Audio levels come from the robot (`conversation.level`); the
// `RobotConversation` below writes them onto the orb and forwards them here.
const onLevels: ((level: ConversationLevelEvent) => void) | null =
  typeof options.onLevels === "function" ? options.onLevels : null;

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

let lastDaemonVersion: string | null = null;

const emitDaemonVersion = (version: string | null): void => {
  lastDaemonVersion = version;
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
const { conversationStarted, convoActiveRequested, unmounted } =
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
// `fsm.set(...)`, `conversationStarted.get()`, etc.

// Selection state (`selectedRobotId`) and the SDK's robot list cache
// (`knownRobots`) live in the `RobotSession` instance now. Use
// `session.getSelectedRobotId()` / `session.setSelectedRobotId()` /
// `session.setKnownRobots()` everywhere.

// The SDK robot ref now lives in the `ConnectionController` (created
// below). The conversation pipeline never touches it directly: it
// reads the live robot through the `liveSession` transport seam, and
// the host handle reads it through `connectionController.getRobot()`.

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
  onConnectionLost: () => onConnectionLost(),
  applyMicMuted: (muted) => applyMicMuted(muted),
});

// The conversation runs on the robot. This starts the conversation app
// through the daemon, waits for its backend, and follows its turn and level
// events into the conversation FSM and the orb.
const robotConversation = createRobotConversation({
  getRobot: liveSession.getRobot,
  getDaemonVersion: () => lastDaemonVersion,
  isUnmounted: unmounted.get,
  setConversationState,
  currentConversationState: conversation.current,
  emitErrorMessage,
  getLevelsTarget: getAudioLevelsTarget,
  onLevels,
  onToolToast,
});

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
        // to idle if the runner is interrupted, then start the app on
        // the robot. `runConversationParts` flips the conversation FSM
        // to `starting` itself so the orb reacts to the tap at once.
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
  // The robot's app owns the mic; this is the same switch its own UI uses.
  robotConversation.setMicMuted(next);
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
 * Bring the conversation up on the robot.
 *
 * The connection (SDK + DataChannel) is already live; the robot's own
 * conversation app does the talking. `robotConversation.start()` starts it
 * through the daemon, waits for its backend, and follows its turn events
 * into the conversation FSM. Idempotent: a second call while running is a
 * no-op. On failure the caption already says why and the FSM is back on
 * `idle`, so the orb shows "tap to start" again.
 */
async function runConversationParts(): Promise<void> {
  if (!liveSession.getRobot() || conversationStarted.get()) return;
  conversationStarted.on();
  if (unmounted.get()) {
    conversationStarted.off();
    return;
  }
  const live = await robotConversation.start();
  if (!live) {
    conversationStarted.off();
    convoActiveRequested.off();
  }
}

/**
 * Stop the conversation on the robot and stop following it. Every path
 * that used to wind the phone-side pipeline down (stop button, tab switch,
 * Hub-app handoff, power-off) lands here, so "stop" always means the app on
 * the robot stops too. Idempotent.
 */
async function tearDownConversationPipeline(): Promise<void> {
  if (!conversationStarted.get()) return;
  convoActiveRequested.off();
  await robotConversation.stop();
  conversationStarted.off();
}

/**
 * Conversation-layer reaction to the connection going down.
 *
 * The connection → conversation seam's teardown half (mirror of
 * `onConnectionLive`): stop the app on the robot and drop the
 * conversation FSM to `idle`, so every teardown caller inherits a clean
 * conversation cursor.
 */
async function onConnectionLost(): Promise<void> {
  await tearDownConversationPipeline();
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
  getMicLevel: robotConversation.getMicLevel,
});
return handle;
} // end of mountConversation
