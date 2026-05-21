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
 *     conversation-engine.ts   ← THIS FILE. FSM, host handle, mount
 *                              lifecycle, wires the session listeners,
 *                              composes everything below.
 *     types.ts                 Public types (Handle, AppState, …).
 *     settings.ts              OpenAI / voice user preferences.
 *     memory.ts                Long-term memory (`remember` tool).
 *     audioLevelMonitor.ts     Mic/AI level monitors driving the orb.
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
import { AiLevelMonitor, MicLevelMonitor } from "./audioLevelMonitor";
import { applyAudioStartupConfig } from "./audio-startup-config";
import { consumeTokenFromHash, whenReachyReady } from "@/features/robot-session/token-hash";
import { loadSettings, type Settings } from "./settings";
import { memoryStore } from "./memory";
import { getActivePersonality } from "@/features/personalities";
import { createDcHealthMonitor } from "@/features/robot-session/dc-health";
import { installBackgroundResilience } from "@/features/robot-session/background-resilience";
import { RobotSession } from "@/features/robot-session/RobotSession";
import { createToolCallHandler } from "./tools/tool-call-handler";
import { createWobblerControl } from "./motion-control/wobbler-control";
import { createAntennasControl } from "./motion-control/antennas-control";
import { createPoseDispatcher } from "./motion-control/pose-dispatcher";
import { createOpenaiBridge } from "./bridge/openai-bridge";
import { attachVision, getVisionPromptAppendix, type VisionHandle } from "../vision";
import {
  getActiveLanguageId,
  getLanguagePromptAppendix,
} from "../../conversation-language";
import type {
  AppState,
  ConversationConnectionAttempt,
  ConversationEngineHandle,
  ConversationEngineOptions,
  ConversationLevelEvent,
  ConversationToolToastEvent,
  ConversationTransportInfo,
} from "./types";

/**
 * Duration (ms) of the smooth ease-out from the wobbler / antennas
 * last animated pose back to neutral when the user stops the
 * conversation (or hands off to an iframe). Long enough to feel
 * intentional - the user perceives the robot "settling down" - but
 * short enough that the post-stop motor-mode switch lands within a
 * second of the tap. 700 ms ≈ 21 frames at the wobbler's 30 Hz
 * stream rate, well above the perception threshold for "abrupt".
 */
const GLIDE_TO_NEUTRAL_MS = 700;

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

// Latest mic level in [0, 1], updated on every audio frame by the
// MicLevelMonitor via the `onLevels` callback. Read via the
// engine handle's `getMicLevel()` for visualisations driven by
// `requestAnimationFrame` (e.g. the microphone card waveform on
// the mobile app) - never trigger React re-renders on this.
//
// Reset to 0 on `unmount()` and on conversation stop, so a stale
// value doesn't bleed into the next session's first paint.
let latestMicLevel = 0;

// Wrap the host's `onLevels` so we capture the mic side into
// `latestMicLevel` before forwarding. The wrapper is what we
// hand to the audio monitors; the user's callback (if any)
// runs untouched. The same wrapper is used for both monitors,
// so the AI side just falls through (only `e.user` matters
// for the mic level capture).
const userOnLevels: ((level: ConversationLevelEvent) => void) | null =
  typeof options.onLevels === "function" ? options.onLevels : null;

const onLevels: (level: ConversationLevelEvent) => void = (level) => {
  if (level.user !== null) {
    latestMicLevel = level.user;
  }
  if (userOnLevels) {
    try {
      userOnLevels(level);
    } catch (err) {
      console.warn("[conversation-engine] onLevels callback threw:", err);
    }
  }
};

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

// ─── Conversation auto-start gate ───────────────────────────────────────
//
// The mobile app needs the WebRTC DC (opened by `robot.startSession`) up
// during the wake-up animation - it doubles as the daemon proxy
// transport. But the antennas / OpenAI / wobbler must NOT fire until the
// user has explicitly clicked "Start conversation" and we're in the
// `live` view, otherwise we get antenna jitter while the wake_up
// trajectory is still playing.
//
// Set the gate's INITIAL value from `options.autoStartConversation`
// (defaults to `true` to preserve the public Space's "tap once → start
// talking" behaviour). The host can toggle it later via
// `handle.startConversation()` / `handle.stopConversation()`.
let convoActiveRequested: boolean = options.autoStartConversation !== false;
// `session.isEstablished()` (was: `let sessionEstablished`) - true once
// `robot.startSession()` has resolved successfully. Used to decide
// whether `startConversation()` can run the conversation parts
// immediately or has to be queued for `doStart` to pick up.
// True once the conversation parts (antennas, OpenAI, wobbler) are
// running. Prevents double-start if the host flips the gate twice or
// `doStart` and `startConversation()` race.
let conversationStarted = false;

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

// ─── Runtime state ──────────────────────────────────────────────────────

// Mobile app: HF auth is gated upstream by `RemoteSignInScreen`
// (the app's entry gate in `App.tsx`), so by the time this engine
// boots the token is already in `sessionStorage` and
// `robot.authenticate()` is just a formality. Start in `connecting`
// (spinner, no caption flash) so the user never sees the "Sign in"
// intro state - it's misleading here since they signed in two
// screens ago. The first `setState` from `boot()` (either to
// `authenticated` or, if the preselected robot id is known,
// straight to `connecting`) takes over almost immediately.
let currentState: AppState = "connecting";
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

// Mic level monitor: feeds a CSS custom property `--audio-level` in [0,1]
// so the circle breathes/glows in reaction to the user's voice in real time.
let micLevel: MicLevelMonitor | null = null;

// AI output level monitor: feeds `--ai-audio-level` in [0,1] from the
// OpenAI output track so the orb's ai-speaking state pulses in sync with
// the actual voice (not a fixed CSS breathe timer). Also exposes a
// silence detector used to gate the transition out of ai-speaking.
let aiLevel: AiLevelMonitor | null = null;

// True while a tool-call choreography is playing. The
// `tools/tool-call-handler` module owns the actual `MovePlayer` and
// `toolPoseRestoreTimer` state; this flag is the only piece of motion
// bookkeeping the engine still needs directly so the wobbler +
// antennas oscillator can skip their 30 Hz writes for the duration
// of the dance (otherwise they'd fight the recorded frames).
let movePlaying = false;

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

function setState(next: AppState): void {
  const wasError = currentState === "error";
  console.log(
    `[DIAG] setState: ${currentState} -> ${next} (sessionEstablished=${session.isEstablished()})`,
  );
  currentState = next;
  // Fan the transition out to the host. The React UI maps this to a
  // visual orb state + caption; tests / loggers may also subscribe.
  if (onStateChange) {
    try {
      onStateChange(next);
    } catch (err) {
      console.warn("[conversation-engine] onStateChange threw:", err);
    }
  }
  // Leaving `error` clears the host's error message so a recovery
  // transition (e.g. user tapped retry → `authenticated`) drops the
  // detail line. Entering `error` is paired with an explicit
  // `onErrorMessageChange(message)` from `onFatalError`.
  if (wasError && next !== "error" && onErrorMessageChange) {
    try {
      onErrorMessageChange(null);
    } catch (err) {
      console.warn(
        "[conversation-engine] onErrorMessageChange threw:",
        err,
      );
    }
  }
  syncMotorModeForState(next);
}

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
 * mobile app is always paired to a specific robot over Bluetooth just
 * before this engine mounts, so the user has already decided which
 * robot they want - a picker would only create ambiguity if the
 * account lists several robots. We therefore auto-select the first
 * robot that appears and let `doStart` drive the rest.
 *
 * If the list ever changes mid-session we keep the currently selected
 * robot: churn in the central's view is not a reason to retarget a
 * live session.
 */
function renderRobotList(robots: RobotInfo[]): void {
  session.setKnownRobots(robots);

  if (currentState !== "connected") return;
  if (!robots.length) return;
  // `pickFirstIfNone()` is a no-op if a robot is already selected,
  // so we don't need a separate `getSelectedRobotId()` guard here -
  // the helper returns null and we fall through.
  const picked = session.pickFirstIfNone();
  if (!picked) return;
  setState("auto-selecting");
  window.setTimeout(() => {
    if (currentState === "auto-selecting") void doStart();
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
    switch (currentState) {
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
        convoActiveRequested = true;
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
  // The SDK's "mic muted" actually gates the OUTBOUND track sent to
  // the robot's speakers. Since we route OpenAI's audio there,
  // muting = the robot stops speaking. That's the right mapping for
  // a "pause the assistant" button.
  try {
    robot?.setMicMuted(next);
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
    // iOS-only WebKit privacy quirk: get the LAN host candidates flowing
    // *before* we kick off the SDK's `connect()` (which immediately
    // starts ICE gathering). Normally the up-front PermissionsScreen
    // has already run this in a clean user-gesture frame; this call
    // is the defensive fallback for users who skipped the onboarding,
    // denied the prompt earlier, or downgraded from a build that
    // didn't have the screen yet. Idempotent and a no-op on desktop.
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
    // the Bluetooth pairing step, so skip the robotsChanged wait and
    // drive straight into startSession. If the id turns out to be
    // stale / wrong, doStart → onFatalError will surface the error
    // and the user can retry; we explicitly don't fall back to the
    // picker flow here because picking a different robot on an
    // account that owns several would contradict the Bluetooth
    // selection and violate the least-surprise principle.
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

  if (!convoActiveRequested) {
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
  if (!robot || conversationStarted) return;

  // OpenAI key gate. We get here when the host explicitly requested a
  // conversation (`convoActiveRequested = true`); the WebRTC robot
  // connection is already up and the DataChannel is carrying daemon
  // proxy traffic, so all we'd lose by bailing is the Realtime
  // pipeline. Surface a clear "Add OpenAI key" message via the host's
  // settings callback and stay in `connected` so the user can still
  // drive the robot via the daemon (wake/sleep, motors, …) while
  // they go fix the configuration.
  if (!settings.apiKey) {
    if (onErrorMessageChange) {
      try {
        onErrorMessageChange("Add OpenAI key in settings");
      } catch (callbackErr) {
        console.warn(
          "[conversation-engine] onErrorMessageChange threw:",
          callbackErr,
        );
      }
    }
    convoActiveRequested = false;
    // No OpenAI key: drop back to `ready` so the user can retry
    // (after fixing settings) by tapping the orb again. The robot
    // side stays usable - DataChannel is alive, motors are enabled,
    // wake-up has played - we just don't have an AI to talk to.
    if (currentState === "starting") setState("ready");
    return;
  }

  conversationStarted = true;

  // If we're being called from the deferred-start path (host flipped
  // the `convoActive` gate after we parked in `ready`), the state
  // machine is currently in `ready`. Re-arm the "starting" UI so the
  // orb shows the spinner during the OpenAI handshake. If we got here
  // from the auto-start path, we're already in `starting` and the
  // call is a no-op.
  if (currentState === "ready") setState("starting");

  // Grab the robot's incoming audio track (the robot's microphone).
  const robotMicTrack = openaiBridge?.getRobotMicTrack(robot) ?? null;
  if (!robotMicTrack) {
    conversationStarted = false;
    onFatalError(new Error("Could not find the robot's microphone track"));
    return;
  }

  startMicLevelMonitor(robotMicTrack);
  // Bring the pose dispatcher up BEFORE the wobbler / antennas
  // start pushing into it - otherwise the first ~50 ms of pose
  // updates would be staged but never flushed (no tick timer
  // running yet). Idempotent: a re-acquire after a release lands
  // here too with the dispatcher already running, no harm done.
  poseDispatcher.start();
  antennasControl.start();
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
    conversationStarted = false;
    onFatalError(err);
    return;
  }

  // Conversation is now fully active (handshake done, output track
  // routed, data channel open). Start the passive scene-awareness
  // module: it'll grab a first frame in ~1.5 s, then every 30 s,
  // plus immediately on any STT keyword trigger. Idempotent; survives
  // transparent reconnects through the bridge's `RealtimePort`.
  vision?.start();

  // Make sure the robot actually sends what OpenAI produces by unmuting the
  // mic path. Our sender now carries the OpenAI audio track, not the local
  // microphone — the `mic` vocabulary in the SDK is legacy.
  robot.setMicMuted(false);

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
 * Stop every audio track captured by the SDK's `_micStream`.
 *
 * Reaches into a private SDK field; the cast is intentional. We
 * accept the coupling because the alternative (forking the npm
 * SDK to add a public `releaseLocalMic()`) would force us to
 * pin a fork instead of `@pollen-robotics/reachy-mini-sdk`. If
 * the field is renamed in a future SDK bump, this becomes a
 * silent no-op (the `?? null` guard) and the iOS mic indicator
 * regression resurfaces — which is observable by inspection on
 * TestFlight, easy to spot and fix.
 */
function releaseSdkPhoneMic(robotInstance: ReachyMiniInstance | null): void {
  if (!robotInstance) return;
  const sdkInternal = robotInstance as unknown as {
    _micStream?: MediaStream | null;
  };
  const stream = sdkInternal._micStream ?? null;
  if (!stream) return;
  for (const track of stream.getAudioTracks()) {
    try {
      track.stop();
    } catch {
      // The track may already have been stopped by an interleaved
      // SDK teardown (rare, but possible if the user power-offs
      // mid-handshake). Nothing to do.
    }
  }
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
    movePlaying = true;
  },
  onMoveEnd: () => {
    movePlaying = false;
  },
  // Coerce `null` (engine convention for "no observer") to `undefined`
  // (handler convention from the optional callback shape).
  onToolToast: onToolToast ?? undefined,
});

// ─── Mic-level monitor (circle audio-reactivity) ────────────────────────

// `MicLevelMonitor` lives in `./audioLevelMonitor.ts`. The closure
// captures `audioLevelsTarget` + `onLevels` and forwards them as
// constructor options on first use, so the class itself is purely
// data-driven and trivially unit-testable in isolation.
function startMicLevelMonitor(track: MediaStreamTrack): void {
  micLevel ??= new MicLevelMonitor({
    getTarget: getAudioLevelsTarget,
    onLevels,
  });
  micLevel.start(track);
}

function stopMicLevelMonitor(): void {
  micLevel?.stop();
  // Reset the cached level so a stale value can't bleed into a
  // remounted visualiser before the first `onLevels` callback of
  // the next session lands. The monitor's `stop()` already clears
  // its CSS vars on the orb; this mirrors that on our cache.
  latestMicLevel = 0;
}

// `AiLevelMonitor` lives in `./audioLevelMonitor.ts` (same file as
// `MicLevelMonitor`). Same closure-capture pattern as the mic side.
function startAiLevelMonitor(track: MediaStreamTrack): void {
  aiLevel ??= new AiLevelMonitor({
    getTarget: getAudioLevelsTarget,
    onLevels,
  });
  aiLevel.start(track);
}

function stopAiLevelMonitor(): void {
  aiLevel?.stop();
}

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
  wobblerControl.resumeAudio();
  micLevel?.resumeAudio();
  aiLevel?.resumeAudio();
  // AntennasOscillator has no AudioContext - it's purely time-based.
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

// ─── Motion controllers ────────────────────────────────────────────────
//
// `motion-control/pose-dispatcher.ts` is a single 30 Hz coalescing
// tick that batches the wobbler's head writes + the antennas
// oscillator's writes into ONE `set_full_target` per tick (with
// SCTP backpressure throttling). Both controllers push their
// updates into the dispatcher rather than calling
// `robot.setHeadRpyDeg` / `robot.setAntennasDeg` directly: that
// halves the data-channel message rate and aligns the two axes
// temporally so the daemon's trajectory player gets a clean,
// predictable cadence.
//
// `motion-control/wobbler-control.ts` and
// `motion-control/antennas-control.ts` own the lifecycle of the
// head wobbler + antennas oscillator. They take a small `deps`
// object and expose a focused `start / stop / freeze / resume /
// reset / resumeAudio / glideToNeutral` surface so the rest of
// the engine doesn't have to know about the underlying
// `HeadWobbler` / `AntennasOscillator` classes from `../motion/`.

const poseDispatcher = createPoseDispatcher({
  getRobot: () => robot,
  recordSend,
});

const wobblerControl = createWobblerControl({
  getRobot: () => robot,
  isPoseLocked: () => toolCallHandler.isPoseLocked(),
  isMovePlaying: () => movePlaying,
  poseDispatcher,
});

const antennasControl = createAntennasControl({
  getRobot: () => robot,
  isMovePlaying: () => movePlaying,
  poseDispatcher,
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
  apiKey: settings.apiKey,
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
    const memoryFragment = memoryStore.formatForPrompt();
    const visionAppendix = getVisionPromptAppendix();
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
  onStatus: (status) => {
    switch (status) {
      case "connected":
        // `connected` arrives from the SDK both (a) when the WebRTC
        // pipe is up for the very first time and (b) when a response
        // completes (response.done / .cancelled). In the latter case
        // the model finished *generating*, but Reachy's voice may
        // still be playing out of the speakers for another ~200 -
        // 500 ms. Stay on `ai-speaking` until the output analyser
        // confirms silence so the UI doesn't snap back to `listening`
        // while we can still hear Reachy.
        if (currentState === "ai-speaking" && aiLevel) {
          // 900 ms of continuous silence before we believe Reachy
          // is actually done. Small sentence-pauses (300 - 600 ms)
          // must NOT trigger the handoff or the UI snaps back to
          // bars mid-response.
          aiLevel.waitForSilence(900, () => {
            // Another event may have moved us elsewhere in the
            // meantime (user barge-in, error, teardown). Only
            // transition if we're still the ones holding the mic.
            if (currentState === "ai-speaking") {
              setState("listening");
              antennasControl.resume();
            }
          });
        } else {
          setState("listening");
          antennasControl.resume();
        }
        break;
      case "user-speaking":
        // Barge-in: cancel any queued "back to listening" from a
        // previous response so it doesn't overwrite the new state a
        // few hundred ms after the user started talking.
        aiLevel?.cancelSilenceWait();
        setState("user-speaking");
        wobblerControl.reset();
        antennasControl.freeze();
        break;
      case "processing":
        setState("processing");
        antennasControl.resume();
        break;
      case "ai-speaking":
        aiLevel?.cancelSilenceWait();
        setState("ai-speaking");
        antennasControl.resume();
        break;
    }
  },
  onOutputTrack: (track) => {
    wobblerControl.start(track);
    startAiLevelMonitor(track);
  },
  onToolCall: (call) => {
    void toolCallHandler.handleToolCall(call);
  },
  onReconnecting: () => {
    // The bridge is rebuilding the OpenAI peer. Pause motion
    // (their input track is about to go away) and drop the orb
    // back to a transient "starting" visual.
    setState("starting");
    wobblerControl.stop();
    antennasControl.freeze();
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
// context. The handle is null when no OpenAI key is configured -
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
const vision: VisionHandle | null = openaiBridge
  ? attachVision({
      realtime: openaiBridge.getRealtimePort(),
      getVideoStream: () => videoCache.get(),
      openaiApiKey: settings.apiKey,
    })
  : null;

async function teardown(): Promise<void> {
  // Stop the vision poller early: its `start()` was paired with the
  // OpenAI handshake in `runConversationParts`, so the matching
  // shutdown belongs at the top of the teardown. Idempotent; the
  // handle stays alive (we only `dispose()` on `unmount`).
  vision?.stop();

  // Cancel any in-flight tool-call choreography + pose-restore timer
  // before we let the wobbler / antennas tear down. The handler stops
  // the `MovePlayer` it owns; we still flip our local `movePlaying`
  // gate because subsequent ticks read it directly.
  toolCallHandler.stop();
  movePlaying = false;

  // Same ordering rule as `stopConversation`: kill the 30 Hz pose
  // streams BEFORE awaiting the long-running OpenAI close. See the
  // comment in stopConversation for why a late wobbler/antennas tick
  // is enough to wedge the Dynamixel bus on the way out.
  wobblerControl.stop();
  antennasControl.stop();
  // Stop the pose dispatcher's coalesced flush. We don't run the
  // glide here (gotoSleep takes over the head/antennas trajectory)
  // so any pending dirty values would be wasted bus traffic
  // immediately fighting the daemon-side sleep animation.
  poseDispatcher.stop();

  // Bridge owns the OpenAI client, audio sink and reconnect counter
  // teardown - including the hidden `<audio>` element used to pump
  // data through the inbound track.
  await openaiBridge?.close();
  openaiBridge?.resetReconnectCounter();

  stopMicLevelMonitor();
  stopAiLevelMonitor();
  // Drop the keepalive AudioContext so iOS lets the audio session
  // revert to `Ambient` and we go back to plain foreground-only
  // behaviour. Safe to call when not running.
  backgroundAudioKeeper.stop();

  // Capture the session flag BEFORE resetting it - we need it to
  // decide whether to run the goto-sleep dance below. Resetting
  // first (the previous version did exactly that) made the
  // `if (sessionEstablished)` guard always fall through, so the
  // robot stayed wide awake on disconnect with motors enabled and
  // the head/antennas frozen wherever the last frame put them.
  const wasSessionEstablished = session.isEstablished();

  // Reset the convo-gate bookkeeping so a subsequent
  // `connect → startSession → startConversation` cycle behaves
  // identically to the first one.
  conversationStarted = false;
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

function wireRobot(): void {
  if (!robot) return;

  // Global SDK probes: log every state-affecting event the central
  // pushes us so we can correlate handoff timing with what the SDK
  // actually saw on its SSE feed. Pure observability, no side
  // effects. Same probe set as the embedded conversation Space's
  // [doStart][probe] block - using the same vocabulary so a single
  // grep across both consoles shows the full handoff trace.
  for (const name of [
    "stateChanged",
    "sessionStarted",
    "sessionStopped",
    "sessionRejected",
    "peerStatusChanged",
    "error",
  ] as const) {
    robot.addEventListener(name, (event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      console.log(`[shell-webrtc][probe] event=${name} detail=`, detail);
    });
  }

  robot.addEventListener("robotsChanged", (event) => {
    const list = (event as CustomEvent<{ robots: RobotInfo[] }>).detail.robots;
    renderRobotList(list);
  });

  robot.addEventListener("sessionStopped", async () => {
    // Drop the cached video stream regardless of the source: a
    // late `attachVideo()` after a session ends should never replay
    // a dead track. The SDK's own `attachVideo` listener already
    // nulls any bound element's `srcObject` on this same event, so
    // the React side stays in sync without us touching the video
    // element directly here.
    videoCache.clear();

    // Distinguish stops we initiated from stops we're observing. See
    // the `expectedStop` counter above for the full rationale; the
    // short version is: when WE called stopSession (release,
    // teardown, watchdog), the caller already owns its own follow-up
    // (state, motor mode, selectedRobotId clearing). Touching any of
    // those here would race the caller and corrupt the FSM - which
    // is exactly the bug that broke the apps-tab handoff in earlier
    // revisions of this file.
    if (sessionGuard.hasPendingExpectedStop()) {
      return;
    }

    // Unsolicited drop: SDK / central / daemon decided this session
    // ended. Nobody else is responsible, so this listener IS the
    // recovery path.
    //
    // We route through `onFatalError()` (which sets state to `error`,
    // emits the message, and runs `teardown()` for us) so the host
    // gets the SAME visible surface as for any other engine failure
    // (per-attempt timeout, libnice crash recovery, OpenAI fatal,
    // mic introuvable, etc.): a full-screen `<SessionErrorView>`
    // with a single "Back" CTA that returns the user to the picker.
    //
    // This unifies the behaviour: every session-level failure is one
    // consistent surface with a clear way out, instead of leaving
    // the user stranded on `RobotSessionScreen` with the engine
    // parked on `authenticated` and the orb showing a misleading
    // mid-bring-up visual + a tiny "session ended" caption that's
    // easy to miss. It also keeps the cleanup deterministic: the
    // next time the user picks the same robot from the scan view,
    // the engine remounts on a fresh slate (motors disabled, no
    // stale session reference, no half-running OpenAI client).
    session.setSelectedRobotId(null);
    applyMicMuted(false);
    await onFatalError(
      new Error(
        "The session ended unexpectedly. The robot may have been " +
          "disconnected, or its daemon was stopped.",
      ),
    );
  });

  // Cache the freshest video stream so late attachers (camera card
  // mounted after the WebRTC negotiation already completed) can
  // catch up. The SDK's `videoTrack` event is one-shot per
  // `startSession`, so without this cache, anyone calling
  // `attachVideo()` past the negotiation window would never get a
  // frame. Re-fires on every reacquire too, so the cache always
  // points at the live track.
  robot.addEventListener("videoTrack", (event) => {
    const detail = (event as CustomEvent<{ track: MediaStreamTrack; stream: MediaStream }>).detail;
    videoCache.set(detail.stream);
    // Diagnostic line: surfaces in the mobile webview console so we
    // can tell whether the daemon is actually publishing video and
    // whether the cache picked it up. The SDK only fires this once
    // per `startSession` so the log is cheap.
    console.info(
      `[conversation-engine] videoTrack received: ` +
        `kind=${detail.track.kind} id=${detail.track.id} ` +
        `enabled=${detail.track.enabled} muted=${detail.track.muted} ` +
        `streamId=${detail.stream.id}`,
    );
  });

  robot.addEventListener("disconnected", () => {
    // Skip during teardown: `unmount()` calls `robot.disconnect()`
    // and immediately nulls the local handle, so a state transition
    // here would just churn React state on a tree the host is
    // already unmounting. The unmount path doesn't rely on this
    // listener for any of its cleanup.
    if (unmounted) return;
    if (robot?.isAuthenticated) {
      setState("authenticated");
    } else {
      setState("signed-out");
    }
  });

  robot.addEventListener("error", (event) => {
    const detail = (event as CustomEvent<{ source: string; error: Error | string }>).detail;
    console.error(`[robot:${detail.source}]`, detail.error);
  });
}

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
    appName: "Reachy Mini Minimal Voice",
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
  wireRobot();

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
    // We used to also gate this on `settings.apiKey` so new users
    // would land on the "Add OpenAI key" nudge before any WebRTC
    // negotiation, but that's wrong for the mobile shell:
    //   * `doConnect()` only opens the SSE signaling channel and the
    //     RTCPeerConnection / DataChannel; it does NOT touch OpenAI.
    //   * Without that DataChannel the daemon proxy (`http_proxy`
    //     over DC) is unreachable, so the daemon-status pill, the
    //     wake/sleep choreography, the engine.bringup watchdog in
    //     `useSessionController`, all stay stuck pending forever.
    //   * The OpenAI key only matters for `doStart()` (Realtime API
    //     handshake), and that branch already returns with an
    //     "Add OpenAI key in settings" message at line ~846.
    // → drive `doConnect()` whenever we have a preselected robot,
    // regardless of OpenAI configuration.
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
// the SDK / boot pipeline. The `currentState` variable up top is set
// to "connecting" but until something calls `setState()` the orb
// keeps the static markup's neutral `class="circle"` (no glow, no
// indicator, no caption). On a slow first paint - SDK still loading,
// `authenticate()` not yet resolved - the user would otherwise see
// an inert violet circle for several seconds.
//
// Calling setState here is also what fans the initial transition
// out to the parent's `onStateChange` observer so the watchdog
// timers in ConversePanel arm right at mount, instead of waiting
// until `boot()` has run far enough to set its first explicit
// state. Match the variable's initial value so we don't burn a
// transition for the same value the boot pipeline will land on
// next.
setState(currentState);

// The legacy "booting" class strip was tied to the engine's old
// inline markup (where the orb's `.ind` defaults clashed with the
// state-applied values, causing a fade-in on first paint). The
// React orb owns those transitions now, so the engine no longer
// touches `root` after mount.

let unmounted = false;
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
    if (unmounted) return;
    await boot();
  })
  .catch((err) => {
    if (unmounted) return;
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
      currentState === "listening" ||
      currentState === "user-speaking" ||
      currentState === "processing" ||
      currentState === "ai-speaking"
    ) {
      resumeAudioContexts();
      void probeRobotLink();
    }
  },
});

const handle: ConversationEngineHandle = {
  unmount: async () => {
    if (unmounted) return;
    unmounted = true;
    disposeBackgroundResilience();
    // Wait for the in-flight boot chain to settle before teardown.
    //
    // Why: teardown() calls `robot.stopSession()`. If the boot
    // chain is still in `await robot.startSession()`, central sees
    // those two interleaved and emits `Session ended before it
    // could start: unknown reason`. By awaiting bootChain first,
    // we let startSession complete (success path) or fail (timeout
    // path inside `doStart`) before tearing down - both end states
    // leave central in a consistent slot we can stopSession on.
    //
    // The 6 s upper bound is a defensive escape hatch: bootChain
    // already has its own 15 s timeout inside `doStart` for a
    // wedged daemon, but we don't want unmount to block longer
    // than the user can tolerate (a tap on Back / power-off should
    // feel instantaneous). 6 s covers the common cases (auth +
    // connect + a brief startSession) without sitting through the
    // worst-case 15 s timeout.
    try {
      await Promise.race([
        bootChain,
        new Promise<void>((resolve) =>
          window.setTimeout(resolve, 6_000),
        ),
      ]);
    } catch {
      // bootChain swallows its errors, so this catch is purely
      // defensive against the timeout race.
    }
    try {
      await teardown();
    } catch (err) {
      console.warn("[conversation-engine] teardown on unmount failed:", err);
    }
    // Terminal release of the vision side-channel. `teardown()` above
    // already stopped its timers; `dispose()` drops the in-memory
    // state so a hypothetical late `start()` after unmount is a
    // guaranteed no-op.
    vision?.dispose();
    // The React layer decides whether to keep the robot instance alive
    // (e.g. to reuse the HF auth). For now we disconnect so subsequent
    // mounts get a fresh state.
    try {
      robot?.disconnect();
    } catch {
      // ignored
    }
    robot = null;
    // Mirror the null on the session so its lifecycle methods can
    // see "no SDK attached" and short-circuit instead of crashing
    // on a dead ref.
    session.detachRobot();
  },

  startConversation: async () => {
    if (unmounted) return;
    if (convoActiveRequested && conversationStarted) return;
    convoActiveRequested = true;
    // Two cases:
    //   1. The SDK session is already up (we parked in `doStart` after
    //      `setSessionEstablished(true)` because auto-start was off).
    //      Resume by running the conversation parts now.
    //   2. The SDK session isn't up yet (e.g. host called startConversation
    //      before robotsChanged fired). The flag is now set, so when
    //      `doStart` runs it'll fall through to `runConversationParts()`
    //      directly instead of returning early.
    if (session.isEstablished() && !conversationStarted) {
      try {
        await runConversationParts();
      } catch (err) {
        console.warn(
          "[conversation-engine] startConversation failed:",
          err,
        );
      }
    }
  },

  stopConversation: async () => {
    if (unmounted) return;
    convoActiveRequested = false;
    if (!conversationStarted) return;
    // "Lite" teardown: stop the conversation pipeline but leave the
    // SDK / DataChannel alive so the daemon proxy keeps working.
    // Mirrors the head of `teardown()` but skips `robot.stopSession()`.
    //
    // Landing sequence (designed for a smooth, calm exit):
    //   1. `toolCallHandler.stop()` cancels any in-flight choreography
    //      / pose-restore timer.
    //   2. `movePlaying = false` SYNC reset so the wobbler / antennas
    //      gates don't suppress the glide frames below.
    //   3. `controls.stop()` clears the wobbler / oscillator timers
    //      WITHOUT pushing a final (0, 0, 0) - that snap is what we're
    //      eliminating.
    //   4. `glideToNeutral(GLIDE_TO_NEUTRAL_MS)` runs an ease-out
    //      cubic at 30 Hz from the last animated pose to neutral.
    //      Run in parallel with the OpenAI bridge close to keep the
    //      total stop latency under a second on a healthy link.
    //   5. Once both have landed, switch to `ready` - which auto-flips
    //      the motor mode to `gravity_compensation` via
    //      `syncMotorModeForState`. Servos hold the neutral pose
    //      passively, no PID buzz.
    vision?.stop();
    toolCallHandler.stop();
    movePlaying = false;
    wobblerControl.stop();
    antennasControl.stop();
    const glide = Promise.all([
      wobblerControl.glideToNeutral(GLIDE_TO_NEUTRAL_MS),
      antennasControl.glideToNeutral(GLIDE_TO_NEUTRAL_MS),
    ]);
    await openaiBridge?.close();
    await glide;
    // Glide is done (final (0,0,0) + (0,0) flushed via flushNow on
    // each axis). Stop the dispatcher's tick - no more pose pushes
    // will arrive until the next conversation starts and brings it
    // back up.
    poseDispatcher.stop();
    openaiBridge?.resetReconnectCounter();
    stopMicLevelMonitor();
    stopAiLevelMonitor();
    backgroundAudioKeeper.stop();
    // Mute the robot mic so any in-flight audio frames don't leak
    // through to the speakers while the OpenAI client is gone.
    try {
      robot?.setMicMuted(true);
    } catch {
      // ignored
    }
    conversationStarted = false;
    // Drop back to the "session up, no convo" parking state so the
    // host can call `startConversation()` again later without the
    // engine's UI lying about its current capabilities. `ready`
    // (not `connected`) is the right target: the SDK + DataChannel
    // are still up and motors are still enabled - the user only
    // dismissed the AI side. The accompanying `setMotorMode(
    // 'gravity_compensation')` (driven by `syncMotorModeForState`)
    // silences the Dynamixel idle buzz now that we've landed on
    // a known neutral pose just above.
    if (session.isEstablished()) setState("ready");
  },

  restartConversation: async () => {
    if (unmounted) return;
    // Mid-session personality switch: the active personality is read
    // lazily by both `composeInstructions` and the `voice` getter
    // (see `createOpenaiBridge` deps above), so the next reconnect
    // automatically picks up the new instructions + voice. We just
    // need to drop the live OpenAI client and bring it back.
    //
    // No-op when the conversation isn't running: a future
    // `startConversation()` will already pull the fresh personality
    // values, so there's nothing to reload here.
    if (!conversationStarted && !convoActiveRequested) return;
    try {
      await handle.stopConversation();
      if (unmounted) return;
      await handle.startConversation();
    } catch (err) {
      console.warn("[conversation-engine] restartConversation failed:", err);
    }
  },

  setMicMuted: (muted: boolean) => {
    if (unmounted) return;
    applyMicMuted(muted);
  },

  requestStop: async () => {
    if (unmounted) return;
    try {
      await handleHostStop();
    } catch (err) {
      console.warn("[conversation-engine] requestStop failed:", err);
    }
  },

  triggerOrbAction: async () => {
    if (unmounted) return;
    try {
      await handleOrbClick();
    } catch (err) {
      console.warn("[conversation-engine] triggerOrbAction failed:", err);
    }
  },

  releaseSessionKeepAwake: async () => {
    if (unmounted) return;
    console.log(
      `[shell-webrtc] releaseSessionKeepAwake: entering, sessionEstablished=${session.isEstablished()}, robot.state=${robot?.state}, conversationStarted=${conversationStarted}`,
    );
    if (!robot || !session.isEstablished()) {
      console.log(
        "[shell-webrtc] releaseSessionKeepAwake: no session to release, no-op",
      );
      // Nothing to release. The host should never call this in a
      // state where there's no session, but we guard defensively
      // so a fast double-tap doesn't throw.
      return;
    }

    // Step 1 - stop any running conversation parts (engine concern,
    // mirrors the body of `stopConversation()` minus the parking-
    // state side effect: we set our own state at the end). Order
    // matters: kill the 30 Hz pose streams synchronously BEFORE any
    // await, otherwise the wobbler / antennas keep ticking through
    // the bridge close and can race the trajectory gate.
    if (conversationStarted) {
      convoActiveRequested = false;
      vision?.stop();
      toolCallHandler.stop();
      // Same landing sequence as the host-facing `stopConversation`:
      // sync `movePlaying = false`, drop the controls' tick timers
      // without snapping, then ease the head + antennas to neutral
      // in parallel with the OpenAI bridge close so the iframe
      // takes over a calmly-posed robot rather than a frozen-mid-
      // motion one.
      movePlaying = false;
      wobblerControl.stop();
      antennasControl.stop();
      const glide = Promise.all([
        wobblerControl.glideToNeutral(GLIDE_TO_NEUTRAL_MS),
        antennasControl.glideToNeutral(GLIDE_TO_NEUTRAL_MS),
      ]);
      await openaiBridge?.close();
      await glide;
      // Glide is done; the dispatcher has flushed the final neutral
      // frame. Stop its tick so the iframe-bound consumer below
      // gets a clean handover (no stale dispatcher writes racing
      // its first commands).
      poseDispatcher.stop();
      openaiBridge?.resetReconnectCounter();
      stopMicLevelMonitor();
      stopAiLevelMonitor();
      backgroundAudioKeeper.stop();
      try {
        robot.setMicMuted(true);
      } catch {
        // ignored
      }
      conversationStarted = false;
    }

    // Step 2 - release the WebRTC session at central. The session
    // class encapsulates: setEstablished(false), reset motor cache,
    // expectedStop-wrapped stopSession, then disconnect to free the
    // SSE producer subscription. Robot stays physically awake.
    await session.release();

    // Step 3 - park in `released` so the host (and any visual state
    // observer) can distinguish "we deliberately let go of the robot"
    // from "we never connected" (`connected`) or "we're tearing down
    // for a goodbye" (no explicit state, the panel unmounts).
    setState("released");
  },

  reacquireSession: async () => {
    if (unmounted) return;
    if (!robot || !session.getSelectedRobotId()) return;
    console.log(
      `[shell-webrtc] reacquireSession: entering, sessionEstablished=${session.isEstablished()}, robot.state=${robot.state}, selectedRobotId=${session.getSelectedRobotId()}`,
    );
    if (session.isEstablished()) {
      console.log(
        "[shell-webrtc] reacquireSession: session already up, no-op",
      );
      // Defensive: the host shouldn't call us when we're already up.
      // Make it a no-op rather than throwing so a UI race doesn't
      // crash the screen.
      return;
    }

    setState("starting");

    // `session.reacquire()` reconnects the SDK if it's dropped (we
    // disconnect during `release()` to free central's producer
    // subscription), then runs `start()` with the same retry-aware
    // helper as the initial bring-up. We do NOT call `wakeUp()`
    // here because the robot stayed physically awake during the
    // handoff - replaying the wake trajectory would freeze the
    // head/antennas back to the wake pose, defeating the
    // "stay where you were" promise of release+reacquire.
    const result = await session.reacquire({
      onAttempt: emitConnectionAttempt,
      isCancelled: () => unmounted,
    });
    if (!result.ok) {
      if (result.cancelled) return;
      onFatalError(result.reason);
      return;
    }

    // Mark session up and park in `ready`. The conversation parts
    // are intentionally NOT auto-resumed: the host stops the
    // conversation when the user leaves the conversation tab (see
    // `RobotSessionScreen`), so by the time we're reacquiring
    // after an iframe handoff there's nothing to resume - the
    // user is back on the conv tab and will tap the orb to start
    // a fresh conversation.
    setSessionEstablished(true);
    setState("ready");
  },

  attachVideo: (videoElement: HTMLVideoElement) => {
    if (unmounted) return () => {};
    // `session.attachVideo` already handles the no-robot guard +
    // late-attach catch-up via the cache (the SDK's `videoTrack`
    // event is a one-shot fired during session negotiation; the
    // cache replay fixes the common "camera card mounts AFTER
    // hasReachedReady" race). Returns the SDK's detach callback.
    return session.attachVideo(videoElement);
  },

  // ─── Audio volume controls ────────────────────────────────────────
  //
  // Thin pass-throughs to the SDK's DataChannel round-trips. We
  // wrap them with try/catch + null guard so the consumer can
  // call them at any time (including before the DC opens or after
  // unmount) without having to special-case the lifecycle.

  // Volume getters/setters keep the same `Promise<number | null>`
  // contract as before; logging is intentionally quiet:
  //   - `null` returns are the expected race when the DataChannel
  //     hasn't opened yet (or just torn down for a release). The
  //     `useDaemonState` provider retries once on null, so flooding
  //     the console with "→ null" on every bring-up was just noise.
  //     We keep them at `console.debug` so devs who need them can
  //     filter the level up; the default browser console hides
  //     debug.
  //   - Successful round-trips and writes still log at `info` so
  //     a user-visible action is traceable in the console.
  getSpeakerVolume: async () => {
    if (unmounted || !robot) return null;
    try {
      const v = await robot.getVolume();
      if (typeof v === "number") console.info("[volume] getSpeakerVolume →", v);
      else console.debug("[volume] getSpeakerVolume → null (DC not ready)");
      return v;
    } catch (err) {
      console.warn("[volume] getSpeakerVolume failed:", err);
      return null;
    }
  },

  setSpeakerVolume: async (volume: number) => {
    if (unmounted || !robot) return null;
    try {
      const applied = await robot.setVolume(volume);
      if (typeof applied === "number") {
        console.info(
          "[volume] setSpeakerVolume",
          volume,
          "→ applied",
          applied,
        );
      } else {
        console.debug(
          "[volume] setSpeakerVolume",
          volume,
          "→ null (DC not ready)",
        );
      }
      return applied;
    } catch (err) {
      console.warn("[volume] setSpeakerVolume failed:", err);
      return null;
    }
  },

  getMicrophoneVolume: async () => {
    if (unmounted || !robot) return null;
    try {
      const v = await robot.getMicrophoneVolume();
      if (typeof v === "number") console.info("[volume] getMicrophoneVolume →", v);
      else console.debug("[volume] getMicrophoneVolume → null (DC not ready)");
      return v;
    } catch (err) {
      console.warn("[volume] getMicrophoneVolume failed:", err);
      return null;
    }
  },

  setMicrophoneVolume: async (volume: number) => {
    if (unmounted || !robot) return null;
    try {
      const applied = await robot.setMicrophoneVolume(volume);
      if (typeof applied === "number") {
        console.info(
          "[volume] setMicrophoneVolume",
          volume,
          "→ applied",
          applied,
        );
      } else {
        console.debug(
          "[volume] setMicrophoneVolume",
          volume,
          "→ null (DC not ready)",
        );
      }
      return applied;
    } catch (err) {
      console.warn("[volume] setMicrophoneVolume failed:", err);
      return null;
    }
  },

  getDaemonVersion: async () => {
    if (unmounted || !robot || typeof robot.getVersion !== "function") {
      return null;
    }
    try {
      const v = await robot.getVersion();
      return typeof v === "string" && v.length > 0 ? v : null;
    } catch (err) {
      console.warn("[engine] getDaemonVersion failed:", err);
      return null;
    }
  },

  getMicLevel: () => latestMicLevel,

  playSound: (file: string) => {
    if (unmounted || !robot) {
      console.warn("[engine] playSound: engine not ready");
      return false;
    }
    try {
      // SDK returns false when the DataChannel isn't open. We
      // surface that to the caller so the UI can decide to skip
      // audible feedback (rather than hang on a silent failure).
      const ok = robot.playSound(file);
      if (!ok) console.warn("[engine] playSound: data channel not open");
      return ok;
    } catch (err) {
      console.warn("[engine] playSound failed:", err);
      return false;
    }
  },

  setHeadRpyDeg: (rollDeg: number, pitchDeg: number, yawDeg: number) => {
    if (unmounted || !robot) {
      // Manual head control surfaces (e.g. the joystick) call this
      // at 20 Hz while the user drags. Spamming a warn on every
      // tick before the engine boots would be noisy; stay silent.
      return false;
    }
    try {
      const ok = robot.setHeadRpyDeg(rollDeg, pitchDeg, yawDeg);
      return ok !== false; // SDK returns undefined on older builds
    } catch (err) {
      console.warn("[engine] setHeadRpyDeg failed:", err);
      return false;
    }
  },

  setBodyYawDeg: (yawDeg: number) => {
    if (unmounted || !robot) {
      // Same rationale as `setHeadRpyDeg`: the joystick's velocity
      // controller calls this on every tick when the head saturates
      // and the user keeps pushing. Stay silent before the engine
      // is mounted; the next viable tick will land.
      return false;
    }
    try {
      const ok = robot.setBodyYawDeg(yawDeg);
      return ok !== false; // SDK returns undefined on older builds
    } catch (err) {
      console.warn("[engine] setBodyYawDeg failed:", err);
      return false;
    }
  },

  subscribeLogs: (options) => {
    // Older SDK builds (pre `feat/subscribe-logs-cmd`) ship without
    // `subscribeLogs`; degrade gracefully to a noop so the consumer's
    // hook stays mountable without runtime guards.
    if (
      unmounted ||
      !robot ||
      typeof (robot as { subscribeLogs?: unknown }).subscribeLogs !== "function"
    ) {
      return () => {};
    }
    try {
      return robot.subscribeLogs(options);
    } catch (err) {
      console.warn("[engine] subscribeLogs failed:", err);
      return () => {};
    }
  },
};
return handle;
} // end of mountConversation
