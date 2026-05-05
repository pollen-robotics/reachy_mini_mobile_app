/**
 * Reachy Mini · voice conversation engine (mobile port).
 *
 * Ported from `reachy_mini_minimal_conversation/src/main.ts`. The logic is
 * left intentionally close to the original Space app so the two stay
 * easy to keep in sync; the only structural change is that the engine
 * now accepts an `HTMLElement` root and performs all its DOM queries
 * relative to it, instead of on `document`. That lets us mount the
 * engine inside any React component - here the `ConversePanel` in
 * `ConnectedScreen`.
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
 */

// Side-effect import: attaches the bundled SDK to `window.ReachyMini`
// and dispatches `reachymini:ready` so the engine's CDN-style waiter
// (`whenReachyReady()`) resolves immediately. Without this the engine
// sits forever in `connecting`, waiting for a global that no <script>
// tag will ever set in the bundled mobile build.
import "./sdkBootstrap";

import { OpenaiRealtimeClient } from "./openai-realtime";
import { HeadWobbler } from "../motion/head-wobbler";
import { AntennasOscillator } from "../motion/antennas";
import {
  MovePlayer,
  MOVE_IDS,
  type MoveId,
} from "../motion/move-player";
import type {
  ReachyMiniInstance,
  RobotInfo,
} from "./globals";
import { isTrajectoryPlaying } from "./trajectoryGate";
import { memoryStore } from "./memory";
import { CENTRAL_SIGNALING_URL } from "../../config";
import { unlockIosMicForWebRtc } from "../permissions/iosMicUnlock";
import { AiLevelMonitor, MicLevelMonitor } from "./audioLevelMonitor";
import {
  TransportMonitor,
  type TransportKind,
} from "./transportMonitor";
import { WakeLockHandle } from "./wakeLock";
import { consumeTokenFromHash, whenReachyReady } from "./tokenHash";
import { loadSettings, type Settings } from "./settings";
import { HEAD_POSES, ROBOT_TOOLS, type HeadPoseName } from "./tools";

export interface ConversationEngineHandle {
  /** Tear down all listeners, audio analysers and WebRTC peer connections.
   *  Safe to call multiple times. */
  unmount: () => Promise<void>;
  /**
   * Activate the conversation parts (antennas oscillator, OpenAI Realtime
   * connection, head wobbler, transport monitor). No-op if the conversation
   * is already active or if the engine hasn't reached the post-session
   * "session-up but idle" state yet (in which case the request is queued
   * and will run as soon as `startSession()` resolves).
   *
   * Used by the mobile app to defer conversation startup until the user
   * is in the `live` view (i.e. has clicked "Start conversation"). The
   * SDK / WebRTC tunnel itself is brought up earlier (during the `engine`
   * phase) because it doubles as the daemon proxy transport.
   */
  startConversation: () => Promise<void>;
  /**
   * Stop the conversation parts but keep the SDK / WebRTC tunnel alive
   * so the daemon proxy keeps working. No-op if the conversation
   * isn't active. Currently unused by the mobile app (it goes through
   * `unmount()` on back navigation), but exposed for symmetry.
   */
  stopConversation: () => Promise<void>;
  /**
   * Toggle the robot microphone gate from the host UI (the React orb's
   * "mute" side button). Mirrors what the engine's own DOM mute button
   * used to do: flips the SDK's `setMicMuted()` and notifies anyone
   * listening through `onMicMutedChange`. Safe to call before the SDK
   * is ready - the latest value is replayed once a robot session is
   * established.
   */
  setMicMuted: (muted: boolean) => void;
  /**
   * Host-driven request to end the current conversation, equivalent
   * to the engine's old "stop" side button: tears the session down
   * via `teardown()` and parks the state machine on the closest
   * sensible idle (`authenticated` or `signed-out`). The host
   * usually prefers `unmount()` for this, but this entrypoint lets
   * the orb itself surface a Stop control without forcing the parent
   * screen to navigate away.
   */
  requestStop: () => Promise<void>;
  /**
   * Forward a click on the React orb. Used to keep the engine's
   * single-button UX (sign-in / connect / retry) without re-introducing
   * a DOM click handler on `#main-circle`. The engine decides what
   * "clicking the orb" means based on `currentState`.
   */
  triggerOrbAction: () => Promise<void>;
  /**
   * Hand the robot off to another consumer (typically an embedded
   * HF Space app rendered in an iframe) WITHOUT putting it to sleep.
   *
   * Stops the conversation parts if they were running, then sends
   * `endSession` to central so the producer slot is free for the
   * iframe's SDK to dial in. The robot stays physically awake
   * (motors enabled, head/antennas where they were), the HF auth /
   * SSE channel stays open. State machine parks in `released`.
   *
   * Asymmetric counterpart to `reacquireSession()`: full lifecycle is
   *   live → releaseSessionKeepAwake() → released
   *        → reacquireSession()       → ready (or live if convo gate on)
   *
   * Architectural note: this is the "B-only" teardown in the A/B/C/D
   * separation - layer A (auth) and C (physical posture) untouched,
   * layer B (WebRTC session) released, layer D (conversation) stopped.
   */
  releaseSessionKeepAwake: () => Promise<void>;
  /**
   * Bring the WebRTC session back up after a previous
   * `releaseSessionKeepAwake()`. Skips wake-up + motor-enable
   * because the robot was kept awake during the handoff.
   *
   * No-op if we're not currently in `released` (the host is expected
   * to gate the call on session state, but the engine guards against
   * double-acquire defensively).
   */
  reacquireSession: () => Promise<void>;
}

/**
 * Engine state machine. Hoisted above `mountConversation` so the
 * `onStateChange` option below can reference it from module scope.
 * All the state-machine code that lives inside `mountConversation`
 * captures this same symbol via closure, so we get one source of
 * truth for transitions and the React watchdog can pattern-match on
 * it without duplicating the union.
 */
export type AppState =
  | "signed-out"
  | "authenticated"
  | "connecting"
  | "connected"
  | "auto-selecting"
  | "starting"
  /**
   * SDK + WebRTC + DataChannel are up, the wake-up trajectory has
   * been kicked off, motors are enabled - the robot is physically
   * "online" - but the conversation pipeline has NOT yet been
   * started (no OpenAI Realtime client, no tool routing, no audio
   * pumps). Reached when the host opted out of `autoStartConversation`,
   * which is the mobile-app default: tap the orb explicitly to flip
   * to `starting` and bring the AI side up.
   *
   * `ready` exists as its own state (rather than reusing `connected`)
   * because the visual identity of the orb differs: `ready` shows
   * the play-icon "press to start" affordance, `connected` is a
   * pure transient state during the connect handshake.
   */
  | "ready"
  | "listening"
  | "user-speaking"
  | "processing"
  | "ai-speaking"
  /**
   * Session was deliberately released for a handoff (e.g. an embedded
   * iframe app needs the robot's WebRTC peer slot). HF auth + SSE are
   * still up, the robot is still PHYSICALLY awake (motors enabled,
   * head/antennas where they were), but `robot.stopSession()` has
   * fired and the central no longer routes us to the robot. A subsequent
   * `reacquireSession()` brings the WebRTC tunnel back without going
   * through the wake-up dance.
   *
   * Distinct from `connected` (which is the transient state DURING the
   * initial connect handshake): `released` is a stable parking state
   * that the host can keep the engine in for as long as the iframe
   * holds the robot.
   */
  | "released"
  | "error";

export interface ConversationEngineOptions {
  /**
   * Peer id the mobile app already knows for the specific Reachy the
   * user paired via Bluetooth. When set, the engine takes a direct
   * path instead of the Space app's public flow:
   *
   *   authenticate() ─▶ robot.connect() ─▶ robot.startSession(id)
   *                    (no user tap)       (no wait on robotsChanged)
   *
   * This is what turns a 10-30 s "Waiting for Reachy" stall into a
   * 1-2 s handshake on mobile: central's `robotsChanged` SSE event
   * can take seconds to fire (relay re-auth, SSE buffering) and
   * sometimes never fires at all if the robot's own relay hasn't
   * finished reconnecting with the freshly stored token.
   *
   * When `undefined` the engine falls back to the original
   * tap-to-connect + auto-select-first-robot behaviour from the
   * Space app. That path also still runs if an auto-start attempt
   * fails with a rejected session (stale id, robot not registered
   * yet) - the engine drops back to `connected` and waits on
   * robotsChanged like before, so this is a pure "fast path"
   * optimisation, never a point of failure.
   */
  preselectedRobotId?: string | null;

  /**
   * Fires on every state-machine transition (`signed-out` → `connecting`
   * → `starting` → …). The React wrapper uses it to drive an external
   * watchdog that flips the UI to "Robot unresponsive - Retry" when we
   * sit in a transient state (`connecting`, `starting`, `auto-selecting`)
   * beyond a reasonable budget.
   *
   * Deliberately a single callback (not EventTarget) to keep the
   * engine's public surface minimal and because React's effect cleanup
   * is the natural disposal point: the wrapper wires it up on mount
   * and throws the callback away on unmount.
   *
   * Called synchronously from inside `setState()` so the observer
   * sees every transition in order, including fast ones (e.g.
   * `connected` → `auto-selecting`) that happen within a single tick.
   */
  onStateChange?: (state: AppState) => void;

  /**
   * When `true` (default), the engine auto-starts the full conversation
   * pipeline as soon as a robot is selected: open WebRTC session, start
   * the antennas oscillator, connect to OpenAI Realtime, wire the head
   * wobbler. This matches the public Space's "tap once → talking"
   * behaviour.
   *
   * When `false`, the engine still goes all the way through
   * `robot.startSession()` (so the WebRTC DataChannel that doubles as
   * the daemon proxy transport is up), but stops there. The conversation
   * parts (antennas, OpenAI, wobbler) only fire when the host calls
   * `handle.startConversation()`.
   *
   * Used by the mobile app to keep the daemon tunnel alive during the
   * wake-up animation (the daemon proxy needs the DC) without animating
   * the antennas or burning OpenAI quota until the user explicitly hits
   * "Start conversation".
   */
  autoStartConversation?: boolean;

  /**
   * Fires whenever the active ICE candidate pair classification changes
   * (`checking` → `lan` / `direct` / `relay`). The mobile app uses it to
   * feed `connectionSummary` so the connection log line carries the
   * actual transport in use, without having to peek at internal stats.
   *
   * Called once on every distinct kind, including the initial
   * `checking` while ICE is still gathering. The engine itself owns
   * the dedup, so the callback won't fire twice for the same kind in
   * a row. Cleared on `unmount()`.
   */
  onTransportChange?: (kind: ConversationTransportKind) => void;

  /**
   * Element on which the engine writes audio-reactive CSS custom
   * properties (`--audio-level`, `--ai-audio-level`, `--bar0..--bar4`)
   * at display rate. The React orb passes its own root here so the
   * audio loop drives only that node's style, instead of polluting
   * `document.documentElement` (which used to leak across HMR /
   * StrictMode remounts).
   *
   * When `null` / omitted the engine writes nowhere - the host gets
   * the levels via `onLevels` if it cares.
   */
  audioLevelsTarget?: HTMLElement | null;

  /**
   * Optional structured stream of audio-reactivity updates. Mostly
   * useful for tests / instrumentation; the typical UI path goes
   * through `audioLevelsTarget` and CSS variables instead, since
   * pumping a 60 Hz callback through React reconciliation is wasteful.
   *
   * Fired from inside the same rAF tick that updates the CSS
   * variables, after the smoothing pass. Either `user` or `ai` is
   * always non-null on a given call, never both.
   */
  onLevels?: (level: ConversationLevelEvent) => void;

  /**
   * Notifies the host when the model triggered a tool call. The React
   * UI surfaces a small pill below the orb with the supplied label
   * for `durationMs`, then dismisses it. Replaces the engine's old
   * imperative `#tool-toast` DOM ping.
   */
  onToolToast?: (toast: ConversationToolToastEvent) => void;

  /**
   * Notifies the host whenever the robot's mic gate flips. Used by
   * the React side controls to render the right icon (mute vs unmute)
   * without keeping a parallel state mirror that could drift from
   * the engine's truth.
   */
  onMicMutedChange?: (muted: boolean) => void;

  /**
   * Lifts the engine's per-error message out of the imperative
   * `#circle-caption` DOM and into a callback. Fired with the message
   * when entering the `error` state, and with `null` whenever we leave
   * it. The host typically renders it as a small caption / tooltip
   * under the orb.
   */
  onErrorMessageChange?: (message: string | null) => void;
}

/**
 * Single-frame audio-reactivity snapshot. Either side can be `null`
 * on a given event because the two analysers run on independent rAF
 * loops; consumers should merge by side as they arrive.
 */
export interface ConversationLevelEvent {
  /** Mic side, `[0..1]` smoothed RMS. */
  user: number | null;
  /** AI side, `[0..1]` smoothed RMS. */
  ai: number | null;
  /** Mic side, `[0..1]` per-band levels (5 log-spaced buckets). */
  bands: readonly [number, number, number, number, number] | null;
}

export interface ConversationToolToastEvent {
  /** Pre-formatted, user-facing label (e.g. `"Move head: tilt left"`). */
  label: string;
  /** Hint for how long the host should keep the pill visible. */
  durationMs: number;
}

/**
 * Active ICE candidate pair classification. Exported so external
 * callers can type their `onTransportChange` callback. Values:
 *
 *   checking - ICE still gathering / no pair nominated yet
 *   lan      - both ends are host candidates on the same LAN
 *   direct   - peer-to-peer through NAT (STUN-discovered candidate)
 *   relay    - traffic going through a TURN relay
 */
export type ConversationTransportKind =
  | "checking"
  | "lan"
  | "direct"
  | "relay";

/**
 * Alias kept for symmetry with the option-name `onStateChange`. Some
 * callers prefer `ConversationState` over `AppState` because the
 * former is less generic-sounding outside this file; both are the
 * same union, exported from the same place.
 */
export type ConversationState = AppState;

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

const audioLevelsTarget: HTMLElement | null =
  options.audioLevelsTarget instanceof HTMLElement
    ? options.audioLevelsTarget
    : null;

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
let openai: OpenaiRealtimeClient | null = null;

// Holds the audio element playing OpenAI's output remotely (so the browser
// keeps the MediaStream alive and actually decodes the incoming track).
let openaiSink: HTMLAudioElement | null = null;

// Head-motion agent: samples the assistant's voice and drives small head
// sways via robot.setHeadPose. Lives for the duration of a session.
let wobbler: HeadWobbler | null = null;

// Idle antenna oscillator: keeps the ears breathing while the robot is
// connected. Freezes while the user speaks, resumes otherwise.
let antennas: AntennasOscillator | null = null;

// Mic level monitor: feeds a CSS custom property `--audio-level` in [0,1]
// so the circle breathes/glows in reaction to the user's voice in real time.
let micLevel: MicLevelMonitor | null = null;

// AI output level monitor: feeds `--ai-audio-level` in [0,1] from the
// OpenAI output track so the orb's ai-speaking state pulses in sync with
// the actual voice (not a fixed CSS breathe timer). Also exposes a
// silence detector used to gate the transition out of ai-speaking.
let aiLevel: AiLevelMonitor | null = null;

// Move player: streams pre-recorded choreographies (dances + emotions) on
// the data channel. Created lazily on the first tool call that needs it.
let movePlayer: MovePlayer | null = null;

// True while a move is playing; we pause the wobbler + antennas oscillator
// so they don't fight the choreography frames.
let movePlaying = false;

// Tracks a pending tool-driven head pose so we can restore motion nicely
// once the gesture completes.
let toolPoseRestoreTimer: number | null = null;

// Set to `true` while we're transparently re-establishing the OpenAI
// session after an ICE failure so the next `error` doesn't double-fire.
let openaiReconnecting = false;

// Per-session count of automatic reconnect attempts (so we give up after
// one try and let the user click again rather than looping forever).
let openaiReconnectAttempts = 0;

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
      await robot.connect();
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

  // Timeout guard: if startSession() never resolves (e.g. the robot-side
  // relay accepted the session but its GStreamer never produces an
  // offer), we MUST abort client-side rather than sit in "Starting…"
  // forever. Leaving the promise pending also leaks a live session on
  // HF central - every subsequent connection attempt (mobile OR the
  // web Space) is then rejected with "Robot is busy: …", until the
  // daemon is manually restarted.
  //
  // 15 seconds is a generous upper bound for a healthy
  // startSession: fresh sessions usually come up in 1-3 s on LAN. If
  // we hit the timeout we actively stopSession() + disconnect() to
  // release central's session state, then surface a retryable error.
  const START_TIMEOUT_MS = 15_000;
  let timedOut = false;
  const timeoutHandle = window.setTimeout(() => {
    timedOut = true;
    // Fire-and-forget: stopSession() sends `endSession` to central so
    // the session is released even if the local _pc handshake is in
    // a weird half-open state.
    void robot?.stopSession().catch(() => {});
  }, START_TIMEOUT_MS);

  try {
    await robot.startSession(selectedRobotId);
  } catch (err) {
    window.clearTimeout(timeoutHandle);
    if (timedOut) {
      onFatalError(
        new Error(
          'Robot did not respond in time. It may be busy with another app. ' +
            'Try again in a moment, or restart the robot if the problem persists.',
        ),
      );
    } else {
      onFatalError(err);
    }
    return;
  }
  window.clearTimeout(timeoutHandle);

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
  // those streams for the wake's duration to avoid clashing. The
  // 8 s cap protects against a stuck daemon: if wake never resolves
  // we still proceed to mark the session ready so the user can at
  // least navigate away.
  try {
    await Promise.race([
      robot.wakeUp({ timeoutMs: 8000 }),
      new Promise<void>((resolve) => setTimeout(resolve, 8500)),
    ]);
  } catch (err) {
    console.warn('[engine] wakeUp failed (ignored):', err);
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
  const robotMicTrack = getRobotMicTrack(robot);
  if (!robotMicTrack) {
    conversationStarted = false;
    onFatalError(new Error("Could not find the robot's microphone track"));
    return;
  }

  startMicLevelMonitor(robotMicTrack);
  startAntennas();
  if (robot._pc) startTransportMonitor(robot._pc, onTransportChange);

  // Keep the device awake for the whole conversation so timers and the
  // media stack don't get throttled on mobile / laptop-on-battery.
  void acquireWakeLock();

  openaiReconnectAttempts = 0;
  try {
    await connectOpenai(robotMicTrack);
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

/**
 * Create an `OpenaiRealtimeClient`, wire its handlers, and await the SDP
 * handshake. Split out of `doStart` so we can call it again for a
 * transparent reconnect when ICE fails.
 */
async function connectOpenai(robotMicTrack: MediaStreamTrack): Promise<void> {
  // Snapshot the user's long-term memory ONCE per connection. We
  // intentionally don't push live updates to the OpenAI session: a
  // `remember` call mid-conversation already carries its fact in the
  // tool-call transcript, so the model knows it's saved without
  // needing the prompt to be re-pushed. The next session start (or
  // an explicit reconnect) is when stale memories get refreshed.
  const memoryFragment = memoryStore.formatForPrompt();
  const composedInstructions = memoryFragment
    ? `${settings.instructions}\n\n${memoryFragment}`
    : settings.instructions;

  const client = new OpenaiRealtimeClient({
    apiKey: settings.apiKey,
    model: settings.model,
    voice: settings.voice,
    instructions: composedInstructions,
    inputTrack: robotMicTrack,
    tools: ROBOT_TOOLS,
  });

  client.on("outputTrack", ({ track }) => {
    routeOpenaiToRobot(track);
    startWobbler(track);
    startAiLevelMonitor(track);
  });

  client.on("status", ({ status }) => {
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
          // 900 ms of continuous silence before we believe Reachy is
          // actually done. Small sentence-pauses (300 - 600 ms) must
          // NOT trigger the handoff or the UI snaps back to bars
          // mid-response.
          aiLevel.waitForSilence(900, () => {
            // Another event may have moved us elsewhere in the
            // meantime (user barge-in, error, teardown). Only
            // transition if we're still the ones holding the mic.
            if (currentState === "ai-speaking") {
              setState("listening");
              antennas?.resume();
            }
          });
        } else {
          setState("listening");
          antennas?.resume();
        }
        openaiReconnectAttempts = 0;
        break;
      case "user-speaking":
        // Barge-in: cancel any queued "back to listening" from a
        // previous response so it doesn't overwrite the new state a
        // few hundred ms after the user started talking.
        aiLevel?.cancelSilenceWait();
        setState("user-speaking");
        wobbler?.reset();
        antennas?.freeze();
        break;
      case "processing":
        setState("processing");
        antennas?.resume();
        break;
      case "ai-speaking":
        aiLevel?.cancelSilenceWait();
        setState("ai-speaking");
        antennas?.resume();
        break;
      case "error":
        if (openaiReconnecting) return;
        void tryReconnectOpenai(robotMicTrack, new Error("OpenAI connection lost"));
        break;
      default:
        break;
    }
  });

  client.on("toolCall", (call) => handleToolCall(call));

  client.on("error", ({ error }) => {
    console.error("[openai]", error);
  });

  openai = client;
  await client.connect();
}

/**
 * Silently tear down the current OpenAI peer connection and try to bring
 * up a fresh one with the same robot mic track. We try exactly once; if
 * that fails the user sees the usual fatal-error UI.
 */
async function tryReconnectOpenai(
  robotMicTrack: MediaStreamTrack,
  cause: Error,
): Promise<void> {
  if (openaiReconnecting) return;
  if (openaiReconnectAttempts >= 1) {
    onFatalError(cause);
    return;
  }

  openaiReconnecting = true;
  openaiReconnectAttempts += 1;
  console.warn("[openai] connection lost, attempting silent reconnect…", cause);
  setState("starting");

  // Pause motion agents while we rebuild the session — they feed off the
  // OpenAI track which is about to go away.
  stopWobbler();
  antennas?.freeze();

  try {
    await openai?.close();
  } catch (err) {
    console.warn("[openai] close during reconnect failed:", err);
  }
  openai = null;

  // Give the network a beat to settle before re-trying - otherwise the
  // new ICE gathering often lands on the same broken path.
  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    await connectOpenai(robotMicTrack);
  } catch (err) {
    openaiReconnecting = false;
    onFatalError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  openaiReconnecting = false;
}

/**
 * Find the audio track the robot is sending us (its on-board microphone).
 * The SDK doesn't expose it directly, so we dig into the RTCPeerConnection.
 */
function getRobotMicTrack(robotInstance: ReachyMiniInstance): MediaStreamTrack | null {
  const pc = robotInstance._pc;
  if (!pc) return null;
  for (const receiver of pc.getReceivers()) {
    if (receiver.track && receiver.track.kind === "audio") {
      return receiver.track;
    }
  }
  return null;
}

/**
 * Pipe the OpenAI-generated audio track to the robot's audio sender
 * (so the robot's speakers play the synthesized voice).
 *
 * We also keep a hidden <audio> element hooked to the track, because some
 * browsers don't pump data through the inbound track until it has a local
 * consumer.
 */
function routeOpenaiToRobot(track: MediaStreamTrack): void {
  if (!robot) return;
  const pc = robot._pc;
  if (!pc) return;

  const audioSender = pc.getSenders().find((s) => s.track && s.track.kind === "audio");
  if (audioSender) {
    audioSender.replaceTrack(track).catch((err) => {
      console.error("[main] replaceTrack failed", err);
    });
  } else {
    console.warn("[main] no audio sender on the robot peer — the robot may not support bidirectional audio");
  }

  if (!openaiSink) {
    openaiSink = document.createElement("audio");
    openaiSink.autoplay = true;
    openaiSink.muted = true;
    document.body.appendChild(openaiSink);
  }
  openaiSink.srcObject = new MediaStream([track]);
}

// ─── Head motion agent ──────────────────────────────────────────────────

/**
 * Spawn the head-motion agent from the assistant audio track. Each new
 * session replaces the previous instance; no-op if the wobbler is already
 * wired to this exact track.
 */
function startWobbler(assistantTrack: MediaStreamTrack): void {
  if (!robot) return;

  wobbler?.stop();
  wobbler = new HeadWobbler({
    track: assistantTrack,
    onOffsets: ({ roll, pitch, yaw }) => {
      // Don't fight an active tool-driven gesture or a streamed move:
      // those own the head while they run.
      if (toolPoseRestoreTimer !== null) return;
      if (movePlaying) return;
      // Same idea for the daemon-side wake_up / goto_sleep trajectories:
      // they own the head for ~2 s and a 30 Hz setHeadPose stream from
      // here would freeze the animation mid-flight.
      if (isTrajectoryPlaying()) return;
      // The SDK's setHeadPose expects degrees. Our offsets are already in
      // degrees; we push them as absolute target poses around the neutral
      // head position (no base pose is preserved, which keeps the motion
      // unambiguously around "looking forward").
      const ok = robot?.setHeadRpyDeg(roll, pitch, yaw) ?? false;
      recordSend(ok, "wobbler");
    },
  });
  wobbler.start();
}

function stopWobbler(): void {
  wobbler?.stop();
  wobbler = null;
  // No direct setHeadPose(0,0,0) here on purpose: the wobbler's own
  // stop() already pushes a neutral pose through its `onOffsets`
  // callback, which honours the trajectory gate. A second un-gated
  // reset would race with daemon-side wake_up / goto_sleep and snap
  // the head from the trajectory's final pose to neutral the instant
  // the gate flips back to false - that's the "antennas/head jumping
  // at the end of sleep" artefact, and it can wedge the Dynamixel bus
  // when it lands on the tail of a long trajectory.
}

// ─── Antennas oscillator ────────────────────────────────────────────────

function startAntennas(): void {
  if (!robot) return;
  antennas?.stop();
  antennas = new AntennasOscillator({
    onAntennas: (right, left) => {
      // Move frames own the antennas while a choreography is streaming -
      // don't clash by pushing our idle oscillation on top.
      if (movePlaying) return;
      // Daemon-side trajectories (wake_up.json, goto_sleep.json) drive
      // the antennas too; muting our oscillator for their duration keeps
      // the animation crisp instead of beating against our 0.5 Hz sine.
      if (isTrajectoryPlaying()) return;
      const ok = robot?.setAntennasDeg(right, left) ?? false;
      recordSend(ok, "antennas");
    },
  });
  antennas.start();
}

function stopAntennas(): void {
  antennas?.stop();
  antennas = null;
  // No direct setAntennas(0, 0) here for the same reason as in
  // stopWobbler(): the oscillator's own stop() already emits a
  // neutral frame through its `onAntennas` callback, and that path
  // is gated by isTrajectoryPlaying(). A bare un-gated reset would
  // win the race against goto_sleep's final frame and "lift" the
  // antennas back up the moment the trajectory ends.
}

// ─── Tool-call handler ─────────────────────────────────────────────────

/**
 * Surface a "model just invoked a tool" pulse to the host. The React
 * layer renders the actual pill under the orb and owns the
 * auto-dismiss timer; the engine only formats the label and forwards
 * a duration hint. Rapid successive calls just queue another event;
 * the host coalesces them by replacing the current pill with the
 * latest one.
 */
function showToolToast(text: string, durationMs = 2800): void {
  if (!onToolToast) return;
  try {
    onToolToast({ label: text, durationMs });
  } catch (err) {
    console.warn("[conversation-engine] onToolToast threw:", err);
  }
}

/**
 * Friendly, human-readable label for the pill. Falls back to the raw
 * tool/arg values for unknown actions so a future tool shows *something*
 * instead of silently displaying nothing.
 */
function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "move_head": {
      const direction = String(args.direction ?? "").toLowerCase();
      const labels: Record<string, string> = {
        up: "Looking up",
        down: "Looking down",
        left: "Looking left",
        right: "Looking right",
        center: "Looking forward",
        neutral: "Looking forward",
      };
      return labels[direction] ?? `Moving head: ${direction || "?"}`;
    }
    case "play_move": {
      const move = String(args.name ?? "");
      return move ? `Playing ${move}` : "Playing move";
    }
    case "remember": {
      // Truncated preview so the toast pill stays compact even when
      // the model writes a long fact.
      const fact = String(args.fact ?? "").trim();
      if (!fact) return "Remembering";
      const preview = fact.length > 36 ? `${fact.slice(0, 33)}...` : fact;
      return `Remembering: ${preview}`;
    }
    case "forget": {
      const query = String(args.query ?? "").trim();
      if (!query) return "Forgetting";
      const preview = query.length > 36 ? `${query.slice(0, 33)}...` : query;
      return `Forgetting: ${preview}`;
    }
    default:
      return `Tool: ${name}`;
  }
}

async function handleToolCall({
  callId,
  name,
  arguments: args,
}: {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}): Promise<void> {
  if (!robot || !openai) return;

  // Surface the pending action immediately so there's no gap between
  // "Reachy says I'll dance" and the dance itself.
  showToolToast(describeToolCall(name, args));

  let result: { ok: boolean; message: string };
  switch (name) {
    case "move_head": {
      const direction = String(args.direction ?? "");
      if (direction in HEAD_POSES) {
        const pose = HEAD_POSES[direction as HeadPoseName];
        applyToolHeadPose(pose);
        result = { ok: true, message: `head moved to ${direction}` };
      } else {
        result = {
          ok: false,
          message: `unknown direction '${direction}'. Valid: ${Object.keys(HEAD_POSES).join(", ")}`,
        };
      }
      break;
    }
    case "play_move": {
      const moveName = String(args.name ?? "");
      if ((MOVE_IDS as readonly string[]).includes(moveName)) {
        try {
          await playMove(moveName as MoveId);
          result = { ok: true, message: `played move '${moveName}'` };
        } catch (err) {
          result = {
            ok: false,
            message: `failed to play '${moveName}': ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      } else {
        result = {
          ok: false,
          message: `unknown move '${moveName}'. Valid: ${MOVE_IDS.join(", ")}`,
        };
      }
      break;
    }
    case "remember": {
      const fact = String(args.fact ?? "");
      const stored = memoryStore.add(fact);
      if (!stored) {
        result = {
          ok: false,
          message:
            "fact was empty or invalid; nothing was saved. Try again " +
            "with a single short sentence about the user.",
        };
      } else {
        // Echo the stored text back so the model can see exactly what
        // ended up in the memory (helps catch its own hallucinated
        // truncations and dedupe matches).
        result = {
          ok: true,
          message: `saved: "${stored.text}"`,
        };
      }
      break;
    }
    case "forget": {
      const query = String(args.query ?? "");
      const { removed, candidates } = memoryStore.forget({ query });
      if (!removed) {
        result = {
          ok: false,
          message: `no memory matched "${query}"; nothing was removed.`,
        };
      } else if (candidates.length > 1) {
        // Tell the model about the other near-matches so it can ask
        // the user "did you mean X or Y?" instead of silently picking.
        const others = candidates
          .slice(1)
          .map((f) => `"${f.text}"`)
          .join(", ");
        result = {
          ok: true,
          message:
            `removed: "${removed.text}". Other facts also matched ` +
            `"${query}": ${others}. Ask the user before forgetting more.`,
        };
      } else {
        result = { ok: true, message: `removed: "${removed.text}"` };
      }
      break;
    }
    default:
      result = { ok: false, message: `unknown tool '${name}'` };
  }

  openai.sendToolResponse(callId, result);
}

/**
 * Play a move end-to-end. Pauses the speech wobble and idle antenna
 * oscillation for the duration, then restores them.
 */
async function playMove(name: MoveId): Promise<void> {
  if (!robot) return;
  movePlayer ??= new MovePlayer(robot);

  movePlaying = true;
  try {
    await movePlayer.play(name);
  } finally {
    movePlaying = false;
    // Snap the antennas back to neutral so the next oscillator tick
    // has a clean starting point.
    robot.setAntennasDeg(0, 0);
  }
}

/**
 * Temporarily lock the head on a named pose (so the wobbler doesn't fight
 * it), hold for ~1.2s, then release so the speech sway resumes.
 */
function applyToolHeadPose(pose: { roll: number; pitch: number; yaw: number }): void {
  if (!robot) return;

  robot.setHeadRpyDeg(pose.roll, pose.pitch, pose.yaw);

  if (toolPoseRestoreTimer !== null) {
    clearTimeout(toolPoseRestoreTimer);
  }
  toolPoseRestoreTimer = window.setTimeout(() => {
    toolPoseRestoreTimer = null;
    // Don't hard-reset to 0,0,0 - the wobbler's next tick will naturally
    // take over from wherever we are. Just clear the lock.
  }, 1200);
}

// ─── Mic-level monitor (circle audio-reactivity) ────────────────────────

// `MicLevelMonitor` lives in `./audioLevelMonitor.ts`. The closure
// captures `audioLevelsTarget` + `onLevels` and forwards them as
// constructor options on first use, so the class itself is purely
// data-driven and trivially unit-testable in isolation.
function startMicLevelMonitor(track: MediaStreamTrack): void {
  micLevel ??= new MicLevelMonitor({ target: audioLevelsTarget, onLevels });
  micLevel.start(track);
}

function stopMicLevelMonitor(): void {
  micLevel?.stop();
}

// `AiLevelMonitor` lives in `./audioLevelMonitor.ts` (same file as
// `MicLevelMonitor`). Same closure-capture pattern as the mic side.
function startAiLevelMonitor(track: MediaStreamTrack): void {
  aiLevel ??= new AiLevelMonitor({ target: audioLevelsTarget, onLevels });
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
  wobbler?.resumeAudio();
  micLevel?.resumeAudio();
  aiLevel?.resumeAudio();
  // AntennasOscillator has no AudioContext - it's purely time-based.
}

const onVisibilityChange = (): void => {
  if (document.hidden) return;
  // Tab came back into focus. Re-arm defences that may have been dropped
  // by the browser while we were away.
  if (currentState === "listening" ||
      currentState === "user-speaking" ||
      currentState === "processing" ||
      currentState === "ai-speaking") {
    void acquireWakeLock();
    resumeAudioContexts();
    void probeRobotLink();
  }
};
document.addEventListener("visibilitychange", onVisibilityChange);

// ─── Robot data-channel health ─────────────────────────────────────────
//
// The audio WebRTC link to the robot is native and usually keeps going
// across background periods. The DATA channel (which carries head poses,
// antennas, `sendRaw` commands) is more fragile: some routers / the SDK
// itself can close it after idle timeouts, in which case motion commands
// land in the void and we'd never notice because we weren't checking the
// SDK's boolean return values.
//
// This probe sends a harmless neutral command and uses the return value
// to gate recovery.

/**
 * Record the outcome of a motion send. Each agent calls this so we can
 * detect a string of failures and surface the issue rather than moving
 * "silently" forever.
 */
let consecutiveSendFailures = 0;
function recordSend(ok: boolean, where: string): void {
  if (ok) {
    consecutiveSendFailures = 0;
    return;
  }
  consecutiveSendFailures += 1;
  if (consecutiveSendFailures === 1 || consecutiveSendFailures % 20 === 0) {
    console.warn(
      `[main] robot send failed (${where}), ${consecutiveSendFailures} consecutive failures`,
    );
  }
  if (consecutiveSendFailures >= 40) {
    onFatalError(
      new Error(
        "Lost the robot data channel (no commands acknowledged). Tap the circle to reconnect.",
      ),
    );
  }
}

/**
 * Ping the robot with a no-op command to verify the data channel is
 * still live. Called on visibility return when a session is active.
 */
async function probeRobotLink(): Promise<void> {
  if (!robot) return;
  // Neutral antennas is a safe "heartbeat" - won't move the robot
  // unless the oscillator was frozen at a non-zero pose, in which case
  // the next tick overwrites this one anyway.
  const ok = robot.setAntennasDeg(0, 0);
  if (!ok) {
    console.warn("[main] robot data channel appears dead after visibility return");
    recordSend(false, "probeRobotLink");
    // Force-escalate even if we haven't hit 40 failures yet: this is a
    // clear signal the channel is gone.
    onFatalError(
      new Error(
        "Lost the robot data channel while the tab was hidden. Tap the circle to reconnect.",
      ),
    );
  }
}

async function teardown(): Promise<void> {
  if (toolPoseRestoreTimer !== null) {
    clearTimeout(toolPoseRestoreTimer);
    toolPoseRestoreTimer = null;
  }

  // Same ordering rule as `stopConversation`: kill the 30 Hz pose
  // streams BEFORE awaiting the long-running OpenAI close. See the
  // comment in stopConversation for why a late wobbler/antennas tick
  // is enough to wedge the Dynamixel bus on the way out.
  stopWobbler();
  stopAntennas();

  movePlayer?.stop();
  movePlaying = false;

  openaiReconnecting = false;
  openaiReconnectAttempts = 0;

  try {
    await openai?.close();
  } catch {
    // ignored
  }
  openai = null;

  stopMicLevelMonitor();
  stopAiLevelMonitor();
  stopTransportMonitor();
  void releaseWakeLock();

  if (openaiSink) {
    openaiSink.srcObject = null;
    openaiSink.remove();
    openaiSink = null;
  }

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
    try {
      await Promise.race([
        robot.gotoSleep({ timeoutMs: 6000 }),
        new Promise<void>((resolve) => setTimeout(resolve, 6500)),
      ]);
    } catch (err) {
      console.warn('[engine] gotoSleep failed (ignored):', err);
    }
    // Belt-and-braces: even if `gotoSleep` returned `completed:
    // true` the daemon's motor mode logic isn't guaranteed to
    // disable torque after the trajectory (only the version
    // controlled by this codebase does). Pushing an explicit
    // `setMotorMode('disabled')` makes the off-switch deterministic
    // across daemon revisions. Synchronous over the DataChannel,
    // so it lands while the WebRTC session is still up.
    try {
      robot.setMotorMode('disabled');
    } catch (err) {
      console.warn('[engine] setMotorMode("disabled") failed (ignored):', err);
    }
  }

  try {
    await robot?.stopSession();
  } catch {
    // ignored
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

  robot.addEventListener("robotsChanged", (event) => {
    const list = (event as CustomEvent<{ robots: RobotInfo[] }>).detail.robots;
    renderRobotList(list);
  });

  robot.addEventListener("sessionStopped", async () => {
    await teardown();
    selectedRobotId = null;
    applyMicMuted(false);
    // Fall back to the pre-session screen rather than the picker; the
    // user can trigger a new run with a single tap.
    if (robot?.isAuthenticated) {
      setState("authenticated");
    } else {
      setState("signed-out");
    }
  });

  robot.addEventListener("disconnected", () => {
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
    clientId: settings.hfClientId || undefined,
    signalingUrl: CENTRAL_SIGNALING_URL,
    // Negotiate the audio tracks up front so the OpenAI Realtime
    // bridge has them ready when the user taps the orb to start
    // the conversation. Without this, the SDK doesn't open the
    // mic-side transceiver and the engine's
    // `getRobotMicTrack(robot)` call later returns undefined.
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
      void doConnect();
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
void whenReachyReady()
  .then(async () => {
    if (unmounted) return;
    await boot();
  })
  .catch((err) => {
    if (unmounted) return;
    void onFatalError(err);
  });

// Best-effort cleanup on page hide / unload.
//
// Why: if the webview is killed without React running `unmount()`
// (app swiped away on iOS, hard reload, native back navigation,
// `tauri:dev` restart, …), we want to at least TRY to tell HF
// central that this session is over, so the robot doesn't stay
// locked as "busy" on the next launch.
//
// We use `pagehide` (fires on iOS Safari's bfcache eviction AND on
// regular unload) rather than `beforeunload` alone because the
// latter is unreliable on mobile.
//
// On top of the SDK's own `disconnect()` (which posts `endSession`
// to central via `fetch`, and which the page-going-away may abort
// before the request leaves the device), we *also* fire a
// `navigator.sendBeacon` to central. sendBeacon is documented to
// queue the request on the browser's network worker so it survives
// the page going away - which is exactly what fetch can't promise
// in a `pagehide` handler on iOS WebView. We send it as a stringified
// JSON `Blob` matching the GStreamer signaling envelope central
// already accepts (`{type:'endSession', sessionId}`), authenticated
// via the `?token=` query string accepted by `/send`. We can't put
// the bearer in a header from sendBeacon.
const CENTRAL_SEND_URL = `${CENTRAL_SIGNALING_URL}/send`;
const onPageHide = (): void => {
  // 1) Beacon-based endSession — survives the page being killed.
  try {
    type RobotInternals = {
      _sessionId?: string | null;
      username?: string | null;
    };
    const internals = robot as unknown as RobotInternals | null;
    const sessionId = internals?._sessionId ?? null;
    const token =
      typeof sessionStorage !== "undefined"
        ? sessionStorage.getItem("hf_token")
        : null;
    if (sessionId && token && typeof navigator !== "undefined" && navigator.sendBeacon) {
      const url = `${CENTRAL_SEND_URL}?token=${encodeURIComponent(token)}`;
      const payload = JSON.stringify({ type: "endSession", sessionId });
      const blob = new Blob([payload], { type: "application/json" });
      navigator.sendBeacon(url, blob);
    }
  } catch {
    // ignored; best-effort only
  }

  // 2) Standard SDK disconnect path: tears down the local PC and (in
  //    healthy conditions) also POSTs endSession via fetch. The
  //    beacon above is the belt; this is the suspenders.
  try {
    robot?.disconnect();
  } catch {
    // ignored; best-effort only
  }
};
window.addEventListener("pagehide", onPageHide);
window.addEventListener("beforeunload", onPageHide);

return {
  unmount: async () => {
    if (unmounted) return;
    unmounted = true;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("beforeunload", onPageHide);
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
    if (toolPoseRestoreTimer !== null) {
      clearTimeout(toolPoseRestoreTimer);
      toolPoseRestoreTimer = null;
    }
    // Kill the 30 Hz pose streams FIRST, synchronously, before any
    // await. The host (RobotSessionScreen) calls stopConversation()
    // and setDesiredState('sleeping') in the same tick when the user
    // taps Back; if we let the wobbler/antennas keep ticking through
    // `await openai?.close()` (which can take a few hundred ms), they
    // race the trajectory gate: as soon as goto_sleep finishes and
    // `isTrajectoryPlaying()` flips back to false, the next 30 Hz
    // tick fires a real setHeadPose / setAntennas and snaps the robot
    // off the trajectory's final pose. That visible jolt is also a
    // burst of writes on the Dynamixel bus right after a long move,
    // and on the physical robot it's enough to wedge the bus for the
    // next session.
    stopWobbler();
    stopAntennas();
    movePlayer?.stop();
    movePlaying = false;
    openaiReconnecting = false;
    openaiReconnectAttempts = 0;
    try {
      await openai?.close();
    } catch {
      // ignored
    }
    openai = null;
    stopMicLevelMonitor();
    stopAiLevelMonitor();
    stopTransportMonitor();
    void releaseWakeLock();
    if (openaiSink) {
      openaiSink.srcObject = null;
      openaiSink.remove();
      openaiSink = null;
    }
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
    // dismissed the AI side.
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
    if (!robot || !sessionEstablished) {
      // Nothing to release. The host should never call this in a
      // state where there's no session, but we guard defensively
      // so a fast double-tap doesn't throw.
      return;
    }
    // Step 1 - stop any running conversation parts (mirrors the body
    // of `stopConversation()` minus the parking-state side effect:
    // we'll set our own state at the end). Order matters: kill the
    // 30 Hz pose streams synchronously BEFORE any await, otherwise
    // the wobbler / antennas keep ticking through the openai close
    // and can race the trajectory gate.
    if (conversationStarted) {
      convoActiveRequested = false;
      if (toolPoseRestoreTimer !== null) {
        clearTimeout(toolPoseRestoreTimer);
        toolPoseRestoreTimer = null;
      }
      stopWobbler();
      stopAntennas();
      movePlayer?.stop();
      movePlaying = false;
      openaiReconnecting = false;
      openaiReconnectAttempts = 0;
      try {
        await openai?.close();
      } catch {
        // ignored
      }
      openai = null;
      stopMicLevelMonitor();
      stopAiLevelMonitor();
      stopTransportMonitor();
      void releaseWakeLock();
      if (openaiSink) {
        openaiSink.srcObject = null;
        openaiSink.remove();
        openaiSink = null;
      }
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
    try {
      await robot.stopSession();
    } catch (err) {
      console.warn("[engine] stopSession during release failed:", err);
    }
    // Park in `released` so the host (and any visual state observer)
    // can distinguish "we deliberately let go of the robot" from
    // "we never connected" (`connected`) or "we're tearing down for
    // a goodbye" (no explicit state, the panel unmounts).
    setState("released");
  },

  reacquireSession: async () => {
    if (unmounted) return;
    if (!robot || !selectedRobotId) return;
    if (sessionEstablished) {
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
      try {
        await robot.connect();
      } catch (err) {
        onFatalError(err);
        return;
      }
    }
    setState("starting");
    // Step 2 - bring the WebRTC tunnel back up. Same `startSession`
    // call as in `doStart()`, with the same 15 s timeout-and-cancel
    // safety net so a stuck robot doesn't leave us in `starting`
    // forever.
    const START_TIMEOUT_MS = 15_000;
    let timedOut = false;
    const timeoutHandle = window.setTimeout(() => {
      timedOut = true;
      void robot?.stopSession().catch(() => {});
    }, START_TIMEOUT_MS);
    try {
      await robot.startSession(selectedRobotId);
    } catch (err) {
      window.clearTimeout(timeoutHandle);
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
    // Step 3 - mark session up. We DO NOT call wakeUp() here: the
    // robot was kept awake during the handoff (that's the whole
    // point of `releaseSessionKeepAwake`). Going through wakeUp
    // would replay the trajectory and freeze the head/antennas
    // back to the wake pose, defeating the "stay where you were"
    // promise.
    setSessionEstablished(true);
    // Park in `ready`: the conversation parts may or may not be
    // wanted on resume. The host triggers `startConversation()`
    // explicitly if the user was mid-conversation before the
    // handoff. Mirroring `doStart`'s parking branch keeps the
    // post-release UX symmetric with the initial bring-up.
    setState("ready");
  },
};
} // end of mountConversation
