/**
 * Reachy Mini · voice conversation engine.
 *
 * This file is the orchestrator: it wires the FSM, host options,
 * and module-level state to the focused subsystems below. Every
 * pure-function chunk that has a clean dependency boundary lives in
 * its own file.
 *
 * Flow driven by a single central circle button:
 *
 *   signed-out  → click → robot.login()  (HF OAuth redirect)
 *   authenticated → click → robot.connect()
 *   connected  → select a robot ⇒ ready
 *   ready      → click → robot.startSession() + OpenAI Realtime WebRTC
 *   streaming  (listening / user-speaking / ai-speaking)
 *
 * Audio routing (robot = hub):
 *   robot mic track (received on robot._pc) ─▶ OpenAI input track
 *   OpenAI output track                     ─▶ robot audio sender (replaceTrack)
 *
 * Architecture (post-refactor)
 * ────────────────────────────
 *
 *   conversation-engine.ts     ← THIS FILE: FSM, boot, robot wiring,
 *                                 mount lifecycle, host-facing handle.
 *
 *   types.ts                   ← Public types (Handle, AppState,
 *                                 Options, level / toast events,
 *                                 transport kinds).
 *
 *   bridge/openai-bridge.ts    ← OpenAI Realtime client lifecycle:
 *                                 SDP handshake, audio sink, output
 *                                 track routing to the robot speaker,
 *                                 silent one-shot reconnect.
 *
 *   motion-control/
 *     wobbler-control.ts       ← `HeadWobbler` lifecycle + gates
 *                                 (pose lock, move-playing, daemon
 *                                 trajectories).
 *     antennas-control.ts      ← `AntennasOscillator` lifecycle +
 *                                 freeze / resume.
 *
 *   tools/
 *     tool-call-handler.ts     ← OpenAI tool dispatch (move_head,
 *                                 play_move, remember, forget) +
 *                                 lazy `MovePlayer` + pose-restore
 *                                 timer.
 *
 *   runtime/
 *     dc-health.ts             ← Robot data-channel failure streak
 *                                 + neutral-antenna heartbeat.
 *     background-resilience.ts ← Wake lock, audio-context resume,
 *                                 page-hide beacon.
 *
 *   audioLevelMonitor.ts       ← MicLevelMonitor + AiLevelMonitor
 *                                 (audio-reactive CSS variables).
 *   transportMonitor.ts        ← Active ICE candidate pair classifier.
 *   wakeLock.ts                ← Screen Wake Lock helper.
 *   settings.ts                ← Local-storage user preferences.
 *   tools.ts                   ← OpenAI tool descriptors + head poses.
 *   memory.ts                  ← Long-term memory store (`remember`).
 *   trajectoryGate.ts          ← Daemon-trajectory yield flag.
 *   tokenHash.ts               ← `#hf_token` URL-fragment plumbing.
 *   sdkBootstrap.ts            ← Side-effect: attach bundled SDK to
 *                                 `window.ReachyMini`.
 *   globals.ts                 ← `ReachyMiniInstance` shape declared
 *                                 from the vendored SDK.
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
import { AiLevelMonitor, MicLevelMonitor } from "./audioLevelMonitor";
import {
  TransportMonitor,
  type TransportKind,
} from "@/features/robot-session/transport-monitor";
import { WakeLockHandle } from "@/features/robot-session/wake-lock";
import { consumeTokenFromHash, whenReachyReady } from "@/features/robot-session/token-hash";
import { loadSettings, type Settings } from "./settings";
import { memoryStore } from "./memory";
import { createDcHealthMonitor } from "@/features/robot-session/dc-health";
import { installBackgroundResilience } from "@/features/robot-session/background-resilience";
import { startRobotSession } from "@/features/robot-session/start-session";
import { sleepAndDisableRobot, wakeRobot } from "@/features/robot-session/physical";
import { createToolCallHandler } from "./tools/tool-call-handler";
import { createWobblerControl } from "./motion-control/wobbler-control";
import { createAntennasControl } from "./motion-control/antennas-control";
import { createPoseDispatcher } from "./motion-control/pose-dispatcher";
import { createOpenaiBridge } from "./bridge/openai-bridge";
import type {
  AppState,
  ConversationConnectionAttempt,
  ConversationEngineHandle,
  ConversationEngineOptions,
  ConversationLevelEvent,
  ConversationToolToastEvent,
  ConversationTransportKind,
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

// Optional external ICE-transport observer. Fired by `TransportMonitor`
// every time the active candidate pair classification changes
// (`checking` → `lan`/`direct`/`relay`). The mobile app feeds it into
// `connectionSummary` so the structured log line carries the live
// transport without needing to call `pc.getStats()` itself.
const onTransportChange: ((kind: ConversationTransportKind) => void) | null =
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
// True once `robot.startSession()` has resolved successfully. We use
// this to decide whether `startConversation()` can run the conversation
// parts immediately or has to be queued for `doStart` to pick up.
let sessionEstablished = false;
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
let selectedRobotId: string | null = null;
const settings: Settings = loadSettings();

// Last known robot list from the SDK's `robotsChanged` event. Cached so we
// can re-evaluate (e.g. after `robot.connect()` resolves) without waiting
// for another event.
let knownRobots: RobotInfo[] = [];

let robot: ReachyMiniInstance | null = null;

// Latest robot video stream. Cached because the SDK's `videoTrack`
// event fires exactly once per `startSession()`, while the host's
// camera card can mount AFTER that point (e.g. it's gated on the
// session reaching `ready`, which only happens once the wake-up
// trajectory completes - well after the WebRTC video transceiver
// has already negotiated). Without this cache, late attachers would
// never see a frame. Cleared on `sessionStopped` so a stale stream
// from a previous session can't leak into a new attach.
let latestVideoStream: MediaStream | null = null;

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

// ─── Stop-session intent counter ──────────────────────────────────────
//
// `robot.stopSession()` triggers a `sessionStopped` event. Two very
// different scenarios produce that event:
//
//   1. WE called stopSession deliberately (release, teardown, watchdog
//      timeout). The caller has its own follow-up logic (state, motor
//      mode, video cache, …); the listener must NOT touch any of that.
//   2. The SDK / central / daemon dropped the session unilaterally
//      (network drop, central evict, daemon crash). Nobody else is
//      responsible; the listener IS the recovery path.
//
// We track case 1 with a single counter: every internal
// `stopSession()` call goes through `expectedStop()`, which bumps the
// counter; the listener checks `pendingExpectedStops > 0` and bails.
// The decrement is deferred by one macrotask (`setTimeout(0)`) so any
// asynchronously-dispatched listener body (resuming after its own
// internal awaits) still reads the count as pending.
let pendingExpectedStops = 0;

function expectedStop(fn: () => Promise<unknown>): Promise<void> {
  pendingExpectedStops++;
  return fn()
    .catch((err) => {
      console.warn("[engine] expectedStop failed:", err);
    })
    .finally(() => {
      window.setTimeout(() => {
        pendingExpectedStops--;
      }, 0);
    })
    .then(() => undefined);
}

// Reconnect bookkeeping (attempt counter + in-flight flag) is owned
// by the OpenAI bridge. The engine exposes `openaiBridge.isReconnecting()`
// as a read-only view for the few sites that need it.

// Screen Wake Lock held for the duration of an active session.
// Prevents mobile / laptop browsers from throttling timers,
// suspending media, or sleeping the device mid-conversation.
// Released on teardown. Implementation in `./wakeLock.ts`; we keep
// a single instance per engine mount so the "unavailable" latch
// persists across visibility flips.
const wakeLock = new WakeLockHandle();

// The mic-muted flag used to live here so the engine could re-paint
// its own button. The React side controls own that state now (kept
// in sync through `onMicMutedChange`), so the engine just forwards
// the new value to the SDK and lets the host render.

function setState(next: AppState): void {
  const wasError = currentState === "error";
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
let lastSetMotorMode: "enabled" | "disabled" | "gravity_compensation" | null =
  null;

function syncMotorModeForState(next: AppState): void {
  if (!robot || !sessionEstablished) return;
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
  if (mode === lastSetMotorMode) return;
  try {
    robot.setMotorMode(mode);
    lastSetMotorMode = mode;
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
  knownRobots = robots;

  if (currentState !== "connected") return;
  if (!robots.length) return;
  if (selectedRobotId) return;

  const picked = robots[0];
  selectedRobotId = picked.id;
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
        selectedRobotId = null;
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
  selectedRobotId = null;
  applyMicMuted(false);
  if (!robot) {
    setState("signed-out");
  } else if (robot.state !== "disconnected") {
    setState("connected");
    renderRobotList(knownRobots);
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
      selectedRobotId = preselectedRobotId;
      setState("auto-selecting");
      await doStart();
      return;
    }

    // Classic path: replay the last robotsChanged snapshot (if the
    // event fired during connect, which it often does) and let
    // renderRobotList auto-pick the first robot or keep waiting.
    renderRobotList(knownRobots);
  } catch (err) {
    onFatalError(err);
  }
}

async function doStart(): Promise<void> {
  if (!robot || !selectedRobotId) return;
  console.log(
    `[shell-webrtc] doStart: entering, selectedRobotId = ${selectedRobotId}, robot.state = ${robot.state}`,
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

  // Bring the WebRTC session up. The retry loop + per-attempt
  // timeout + libnice-crash recovery all live in
  // `features/robot-session/start-session.ts` - extracted from the
  // engine so the session-bring-up logic is independently
  // testable and the engine stays a thin orchestrator. We pass
  // `expectedStop` so internal stopSession bailouts on timeout
  // don't trigger the engine's unsolicited-drop recovery path.
  const result = await startRobotSession({
    robot,
    peerId: selectedRobotId,
    expectedStop,
    onAttempt: emitConnectionAttempt,
    isCancelled: () => !robot || !selectedRobotId,
  });

  if (!result.ok) {
    if (result.cancelled) return;
    onFatalError(result.reason);
    return;
  }

  // Wake the robot now that the data channel is live. Self-contained
  // module: the host doesn't have an SDK ref of its own anymore, so
  // the engine owns the full `connect → session → wake → talk` chain.
  //
  // We AWAIT the wake-up here so the host's "Connecting to your
  // Reachy" transition view stays up for the duration of the wake
  // animation (~2 s on a healthy robot). The state machine doesn't
  // flip to `ready` until motors are actually enabled and the head
  // / antennas have settled into their wake pose - that matches the
  // user's mental model ("ready" means physically online, not just
  // "WebRTC handshake complete").
  //
  // The trajectory gate inside head-wobbler/antennas already mutes
  // those streams for the wake's duration to avoid clashing.
  // `wakeRobot` enforces a JS-side hard timeout so a stuck daemon
  // never blocks our progress to `ready`.
  await wakeRobot(robot);

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
  if (robot._pc) startTransportMonitor(robot._pc, onTransportChange);

  // Keep the device awake for the whole conversation so timers and the
  // media stack don't get throttled on mobile / laptop-on-battery.
  void acquireWakeLock();

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

  // Make sure the robot actually sends what OpenAI produces by unmuting the
  // mic path. Our sender now carries the OpenAI audio track, not the local
  // microphone — the `mic` vocabulary in the SDK is legacy.
  robot.setMicMuted(false);
}

/**
 * Hook into `sessionEstablished` so test code / future callers can
 * observe the transition. Today it's just a setter, but kept as a
 * function so the assignments are greppable.
 */
function setSessionEstablished(value: boolean): void {
  sessionEstablished = value;
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

// ─── Transport path monitor ────────────────────────────────────────────
// `TransportMonitor` + `selectedTransportKind` live in
// `./transportMonitor.ts`. Self-contained class - the `listener` is
// passed to `start()` per session, no closure capture needed.
let transportMonitor: TransportMonitor | null = null;

function startTransportMonitor(
  pc: RTCPeerConnection,
  listener: ((kind: TransportKind) => void) | null = null,
): void {
  transportMonitor ??= new TransportMonitor();
  transportMonitor.start(pc, listener);
}

function stopTransportMonitor(): void {
  transportMonitor?.stop();
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
// We mitigate with a Wake Lock during the session and a visibilitychange
// handler that re-acquires the lock and resumes any suspended contexts.

// Wake-lock acquire/release are now methods on the `WakeLockHandle`
// instance above. Local function aliases keep the call sites in this
// file readable without sprinkling `wakeLock.` everywhere.
function acquireWakeLock(): Promise<void> {
  return wakeLock.acquire();
}

function releaseWakeLock(): Promise<void> {
  return wakeLock.release();
}

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
  voice: settings.voice,
  composeInstructions: () => {
    // Snapshot the user's long-term memory ONCE per connection. We
    // intentionally don't push live updates to the OpenAI session: a
    // `remember` call mid-conversation already carries its fact in
    // the tool-call transcript, so the model knows it's saved
    // without needing the prompt to be re-pushed. The next session
    // start (or an explicit reconnect) is when stale memories get
    // refreshed.
    const memoryFragment = memoryStore.formatForPrompt();
    return memoryFragment
      ? `${settings.instructions}\n\n${memoryFragment}`
      : settings.instructions;
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

async function teardown(): Promise<void> {
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
  stopTransportMonitor();
  void releaseWakeLock();

  // Capture the session flag BEFORE resetting it - we need it to
  // decide whether to run the goto-sleep dance below. Resetting
  // first (the previous version did exactly that) made the
  // `if (sessionEstablished)` guard always fall through, so the
  // robot stayed wide awake on disconnect with motors enabled and
  // the head/antennas frozen wherever the last frame put them.
  const wasSessionEstablished = sessionEstablished;

  // Reset the convo-gate bookkeeping so a subsequent
  // `connect → startSession → startConversation` cycle behaves
  // identically to the first one.
  conversationStarted = false;
  sessionEstablished = false;

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
    // `sleepAndDisableRobot` plays the goto-sleep trajectory,
    // hard-bounded by a JS timeout, then forces motor mode to
    // `'disabled'` deterministically (the daemon's own motor
    // mode handling after gotoSleep varies across revisions).
    // Both steps run BEFORE `stopSession()` below so they land
    // while the WebRTC DataChannel is still up.
    const result = await sleepAndDisableRobot(robot);
    if (result.motorMode === 'disabled') {
      lastSetMotorMode = 'disabled';
    }
  }

  if (robot) {
    // Wrapped in `expectedStop` so the `sessionStopped` listener
    // doesn't try to run its own (now redundant) cleanup path. The
    // teardown() function above already handles motor mode, audio
    // monitors, conversation parts, and the wake-lock; the listener
    // would otherwise also reset `selectedRobotId` and force a
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
    latestVideoStream = null;

    // Distinguish stops we initiated from stops we're observing. See
    // the `expectedStop` counter above for the full rationale; the
    // short version is: when WE called stopSession (release,
    // teardown, watchdog), the caller already owns its own follow-up
    // (state, motor mode, selectedRobotId clearing). Touching any of
    // those here would race the caller and corrupt the FSM - which
    // is exactly the bug that broke the apps-tab handoff in earlier
    // revisions of this file.
    if (pendingExpectedStops > 0) {
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
    selectedRobotId = null;
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
    latestVideoStream = detail.stream;
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
// session needs (re-acquire wake lock, resume audio analysers, probe
// the data channel).
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
      void acquireWakeLock();
      resumeAudioContexts();
      void probeRobotLink();
    }
  },
});

return {
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
    // The React layer decides whether to keep the robot instance alive
    // (e.g. to reuse the HF auth). For now we disconnect so subsequent
    // mounts get a fresh state.
    try {
      robot?.disconnect();
    } catch {
      // ignored
    }
    robot = null;
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
    if (sessionEstablished && !conversationStarted) {
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
    stopTransportMonitor();
    void releaseWakeLock();
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
    if (sessionEstablished) setState("ready");
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
      `[shell-webrtc] releaseSessionKeepAwake: entering, sessionEstablished=${sessionEstablished}, robot.state=${robot?.state}, conversationStarted=${conversationStarted}`,
    );
    if (!robot || !sessionEstablished) {
      console.log(
        "[shell-webrtc] releaseSessionKeepAwake: no session to release, no-op",
      );
      // Nothing to release. The host should never call this in a
      // state where there's no session, but we guard defensively
      // so a fast double-tap doesn't throw.
      return;
    }
    // Step 1 - stop any running conversation parts (mirrors the body
    // of `stopConversation()` minus the parking-state side effect:
    // we'll set our own state at the end). Order matters: kill the
    // 30 Hz pose streams synchronously BEFORE any await, otherwise
    // the wobbler / antennas keep ticking through the bridge close
    // and can race the trajectory gate.
    if (conversationStarted) {
      convoActiveRequested = false;
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
      stopTransportMonitor();
      void releaseWakeLock();
      try {
        robot.setMicMuted(true);
      } catch {
        // ignored
      }
      conversationStarted = false;
    }
    // Step 2 - release the WebRTC session at central. We deliberately
    // do NOT call gotoSleep / setMotorMode('disabled') / disconnect()
    // here: the robot must stay physically awake (so a re-acquire is
    // instant, no wake animation) and the HF auth / SSE channel must
    // stay alive (so reacquire skips a full reconnect).
    setSessionEstablished(false);
    // The iframe taking over may flip the motor mode itself; we no
    // longer have an authoritative view of what's on the robot.
    // Resetting the dedup cache forces the first post-reacquire
    // `syncMotorModeForState()` to send rather than skip on stale info.
    lastSetMotorMode = null;
    // Wrapped in `expectedStop` so the `sessionStopped` listener
    // doesn't run its unsolicited-drop recovery (which would reset
    // `selectedRobotId` to null and force the FSM to `authenticated`,
    // breaking the matching `reacquireSession()` call).
    const stopT0 = performance.now();
    console.log(
      `[shell-webrtc] releaseSessionKeepAwake: calling robot.stopSession() (state before = ${robot.state})...`,
    );
    await expectedStop(() => robot!.stopSession());
    console.log(
      `[shell-webrtc] releaseSessionKeepAwake: stopSession resolved in ${Math.round(
        performance.now() - stopT0,
      )}ms, robot.state = ${robot.state}`,
    );

    // Then drop the central's *producer subscription* too. The earlier
    // "keep-awake" design only called `stopSession()` so a re-acquire
    // could skip a full reconnect, but in practice that left the shell's
    // SSE producer-subscription open on the central, and the central
    // routes any subsequent `startSession` for the same robot back to
    // that still-open subscription instead of relaying it to the new
    // client (the iframe). Empirical signature was: iframe sees the
    // robot in `robot.robots`, calls `startSession`, and gets exactly
    // zero events for the full 15 s timeout window — no
    // `sessionRejected`, no `peerStatusChanged`, nothing. Disconnecting
    // here makes the iframe's `connect()` the sole producer subscription
    // for the lease window, which is what the central actually expects.
    //
    // Cost: the matching `reacquireSession()` now needs a fresh
    // `connect()` before its `startSession()` (~700 ms on LAN). The
    // path is already handled there (the `if (robot.state ===
    // "disconnected") await robot.connect()` branch).
    console.log(
      "[shell-webrtc] releaseSessionKeepAwake: calling robot.disconnect() to free the central's producer subscription...",
    );
    robot.disconnect();
    console.log(
      `[shell-webrtc] releaseSessionKeepAwake: disconnected, robot.state = ${robot.state}`,
    );

    // Park in `released` so the host (and any visual state observer)
    // can distinguish "we deliberately let go of the robot" from
    // "we never connected" (`connected`) or "we're tearing down for
    // a goodbye" (no explicit state, the panel unmounts).
    setState("released");
  },

  reacquireSession: async () => {
    if (unmounted) return;
    if (!robot || !selectedRobotId) return;
    console.log(
      `[shell-webrtc] reacquireSession: entering, sessionEstablished=${sessionEstablished}, robot.state=${robot.state}, selectedRobotId=${selectedRobotId}`,
    );
    if (sessionEstablished) {
      console.log(
        "[shell-webrtc] reacquireSession: session already up, no-op",
      );
      // Defensive: the host shouldn't call us when we're already up.
      // Make it a no-op rather than throwing so a UI race doesn't
      // crash the screen.
      return;
    }
    // Step 1 - the SDK keeps its peer-status producer subscription
    // open across stopSession() (we deliberately did NOT call
    // disconnect() in releaseSessionKeepAwake), so we typically don't
    // need to re-authenticate or re-open the SSE here. Belt-and-
    // suspenders: if the SDK has fallen back to `disconnected`
    // (e.g. central kicked the producer during the release),
    // reconnect first.
    if (robot.state === "disconnected") {
      const connectT0 = performance.now();
      console.log(
        "[shell-webrtc] reacquireSession: SDK is disconnected, calling robot.connect()...",
      );
      try {
        await robot.connect();
        console.log(
          `[shell-webrtc] reacquireSession: connect resolved in ${Math.round(
            performance.now() - connectT0,
          )}ms`,
        );
      } catch (err) {
        console.warn(
          "[shell-webrtc] reacquireSession: connect rejected:",
          err,
        );
        onFatalError(err);
        return;
      }
    }
    setState("starting");
    // Step 2 - bring the WebRTC tunnel back up. Same `startSession`
    // call as in `doStart()`, with the same 15 s timeout-and-cancel
    // safety net so a stuck robot doesn't leave us in `starting`
    // forever. Wrapped in `expectedStop` so the cancel doesn't
    // trip the unsolicited-drop recovery.
    const START_TIMEOUT_MS = 15_000;
    let timedOut = false;
    const timeoutHandle = window.setTimeout(() => {
      timedOut = true;
      if (robot) {
        void expectedStop(() => robot!.stopSession());
      }
    }, START_TIMEOUT_MS);
    const startT0 = performance.now();
    console.log(
      `[shell-webrtc] reacquireSession: calling robot.startSession(${selectedRobotId})...`,
    );
    try {
      await robot.startSession(selectedRobotId);
      console.log(
        `[shell-webrtc] reacquireSession: startSession resolved in ${Math.round(
          performance.now() - startT0,
        )}ms, robot.state = ${robot.state}`,
      );
    } catch (err) {
      window.clearTimeout(timeoutHandle);
      console.warn(
        `[shell-webrtc] reacquireSession: startSession rejected after ${Math.round(
          performance.now() - startT0,
        )}ms (timedOut=${timedOut}):`,
        err,
      );
      if (timedOut) {
        onFatalError(
          new Error(
            "Robot did not respond in time after handoff. " +
              "Try again in a moment.",
          ),
        );
      } else {
        onFatalError(err);
      }
      return;
    }
    window.clearTimeout(timeoutHandle);
    // Step 3 - mark session up and park in `ready`. We DO NOT call
    // wakeUp() here: the robot was kept awake during the handoff
    // (that's the whole point of `releaseSessionKeepAwake`). Going
    // through wakeUp would replay the trajectory and freeze the
    // head/antennas back to the wake pose, defeating the "stay
    // where you were" promise.
    //
    // The conversation parts are intentionally NOT auto-resumed:
    // the host stops the conversation when the user leaves the
    // conversation tab (see `RobotSessionScreen`), so by the time
    // we're reacquiring after an iframe handoff there's nothing to
    // resume - the user is back on the conv tab and will tap the
    // orb to start a fresh conversation.
    setSessionEstablished(true);
    setState("ready");
  },

  attachVideo: (videoElement: HTMLVideoElement) => {
    if (unmounted || !robot) {
      // No live SDK instance to bind to. Returning a no-op keeps the
      // host's `useEffect` cleanup symmetrical and avoids special-
      // casing the null branch on the consumer side.
      return () => {};
    }
    try {
      const detach = robot.attachVideo(videoElement);
      // Late-attach catch-up. The SDK's `videoTrack` event is a
      // one-shot fired during session negotiation. If the host
      // mounts the camera AFTER that negotiation (which is the
      // common case - the card is gated on `hasReachedReady`), the
      // SDK's freshly-registered listener won't fire again until
      // the next `startSession`, so we'd be stuck on a black frame
      // forever. Replay the cached stream onto the element here so
      // we reach a live frame on the very next paint.
      if (latestVideoStream && videoElement.srcObject !== latestVideoStream) {
        videoElement.srcObject = latestVideoStream;
        // Best-effort autoplay: the element is `autoPlay muted` on
        // the React side, so this resolves immediately on most
        // platforms. Swallow the rejection (Safari can throw if
        // the user hasn't interacted with the page yet - the
        // upstream gesture from tapping the orb satisfies the
        // requirement, so this is mostly defensive).
        void videoElement.play().catch(() => {
          /* ignored */
        });
      }
      return detach;
    } catch (err) {
      console.warn("[conversation-engine] attachVideo failed:", err);
      return () => {};
    }
  },

  // ─── Audio volume controls ────────────────────────────────────────
  //
  // Thin pass-throughs to the SDK's DataChannel round-trips. We
  // wrap them with try/catch + null guard so the consumer can
  // call them at any time (including before the DC opens or after
  // unmount) without having to special-case the lifecycle.

  getSpeakerVolume: async () => {
    if (unmounted || !robot) {
      console.warn("[volume] getSpeakerVolume: engine not ready");
      return null;
    }
    try {
      const v = await robot.getVolume();
      console.info("[volume] getSpeakerVolume →", v);
      return v;
    } catch (err) {
      console.warn("[volume] getSpeakerVolume failed:", err);
      return null;
    }
  },

  setSpeakerVolume: async (volume: number) => {
    if (unmounted || !robot) {
      console.warn("[volume] setSpeakerVolume: engine not ready");
      return null;
    }
    try {
      const applied = await robot.setVolume(volume);
      console.info(
        "[volume] setSpeakerVolume requested",
        volume,
        "→ applied",
        applied,
      );
      return applied;
    } catch (err) {
      console.warn("[volume] setSpeakerVolume failed:", err);
      return null;
    }
  },

  getMicrophoneVolume: async () => {
    if (unmounted || !robot) {
      console.warn("[volume] getMicrophoneVolume: engine not ready");
      return null;
    }
    try {
      const v = await robot.getMicrophoneVolume();
      console.info("[volume] getMicrophoneVolume →", v);
      return v;
    } catch (err) {
      console.warn("[volume] getMicrophoneVolume failed:", err);
      return null;
    }
  },

  setMicrophoneVolume: async (volume: number) => {
    if (unmounted || !robot) {
      console.warn("[volume] setMicrophoneVolume: engine not ready");
      return null;
    }
    try {
      const applied = await robot.setMicrophoneVolume(volume);
      console.info(
        "[volume] setMicrophoneVolume requested",
        volume,
        "→ applied",
        applied,
      );
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
};
} // end of mountConversation
