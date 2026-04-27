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

import { OpenaiRealtimeClient, type RealtimeTool } from "./openai-realtime";
import { HeadWobbler } from "./head-wobbler";
import { AntennasOscillator } from "./antennas";
import {
  MovePlayer,
  MOVE_CATALOG,
  MOVE_IDS,
  type MoveId,
} from "./move-player";
import type {
  ReachyMiniInstance,
  RobotInfo,
} from "./globals";
import { isTrajectoryPlaying } from "../daemon/trajectoryGate";

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
  | "listening"
  | "user-speaking"
  | "processing"
  | "ai-speaking"
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
}

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

// ─── Settings & defaults ────────────────────────────────────────────────

const DEFAULT_MODEL = "gpt-realtime";
const DEFAULT_VOICE = "cedar";
const DEFAULT_INSTRUCTIONS =
  "You are Reachy Mini, a small friendly robot companion. " +
  "Keep replies short, warm, and spoken. Avoid long monologues. " +
  "You control a small robot body. Two tools are available:\n" +
  "  - `move_head`: point the head in a named direction (up, down, left, " +
  "right, tilt_left, tilt_right, center). Instant, use for subtle gestures " +
  "that accompany a sentence.\n" +
  "  - `play_move`: trigger a short pre-recorded choreography (1-4s). The " +
  "catalog mixes `dance` entries (rhythmic, playful) and `emotion` entries " +
  "(reactive body language). Pick a dance when the moment calls for " +
  "theatricality (hi, joke, groove) and an emotion when reacting to " +
  "something the user just said (surprise, curiosity, praise, bad news).\n" +
  "Use tools sparingly, never more than once per reply.";

// ─── Robot tools exposed to the OpenAI model ────────────────────────────

/**
 * Predefined head poses (roll/pitch/yaw in degrees) the model can target
 * via the single `move_head` tool. Kept small and readable: the model just
 * picks a named direction, we do the geometry.
 */
const HEAD_POSES = {
  center: { roll: 0, pitch: 0, yaw: 0 },
  up: { roll: 0, pitch: -18, yaw: 0 },
  down: { roll: 0, pitch: 18, yaw: 0 },
  left: { roll: 0, pitch: 0, yaw: 25 },
  right: { roll: 0, pitch: 0, yaw: -25 },
  tilt_left: { roll: -15, pitch: 0, yaw: 0 },
  tilt_right: { roll: 15, pitch: 0, yaw: 0 },
} as const;

type HeadPoseName = keyof typeof HEAD_POSES;

const ROBOT_TOOLS: RealtimeTool[] = [
  {
    name: "move_head",
    description:
      "Point the robot's head in a named direction. Use this to accompany " +
      "your speech with a tiny, legible gesture (e.g. `up` when celebrating, " +
      "`tilt_left` when curious, `center` to reset).",
    parameters: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: Object.keys(HEAD_POSES),
          description: "Named head pose to assume.",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "play_move",
    description:
      "Trigger a short pre-recorded body-language move (1-4s) from the " +
      "Reachy dances + emotions library. Catalog (each line is `id | kind | " +
      "when to pick it`):\n" +
      MOVE_CATALOG.map(
        (m) => `  - ${m.id} | ${m.kind} | ${m.description}`,
      ).join("\n"),
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: [...MOVE_IDS],
          description:
            "Catalog id to play. See the description for guidance on " +
            "which id fits which conversational moment.",
        },
      },
      required: ["name"],
    },
  },
];

const STORAGE_KEYS = {
  hfClientId: "reachyMini.hf.clientId",
  apiKey: "reachyMini.openai.apiKey",
  model: "reachyMini.openai.model",
  voice: "reachyMini.openai.voice",
  instructions: "reachyMini.openai.instructions",
} as const;

interface Settings {
  hfClientId: string;
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
}

function loadSettings(): Settings {
  return {
    hfClientId: localStorage.getItem(STORAGE_KEYS.hfClientId) ?? "",
    apiKey: localStorage.getItem(STORAGE_KEYS.apiKey) ?? "",
    model: localStorage.getItem(STORAGE_KEYS.model) ?? DEFAULT_MODEL,
    voice: localStorage.getItem(STORAGE_KEYS.voice) ?? DEFAULT_VOICE,
    instructions: localStorage.getItem(STORAGE_KEYS.instructions) ?? DEFAULT_INSTRUCTIONS,
  };
}

function saveSettings(s: Settings): void {
  localStorage.setItem(STORAGE_KEYS.hfClientId, s.hfClientId);
  localStorage.setItem(STORAGE_KEYS.apiKey, s.apiKey);
  localStorage.setItem(STORAGE_KEYS.model, s.model);
  localStorage.setItem(STORAGE_KEYS.voice, s.voice);
  localStorage.setItem(STORAGE_KEYS.instructions, s.instructions);
}

// ─── App state machine ──────────────────────────────────────────────────
// `AppState` itself is defined at module scope (above `mountConversation`)
// so `ConversationEngineOptions.onStateChange` can reference it. This
// closure still uses it via the normal outer-scope lookup, nothing else
// to thread.

interface StateView {
  /**
   * Short caption shown below the orb. Empty string = no caption row at
   * all (the orb's visual state is enough). We only surface a caption
   * when it's actionable (call-to-action / ambiguous states); during an
   * active conversation the orb's animations speak for themselves.
   */
  caption: string;
  /** If true the orb looks disabled and ignores clicks. */
  disabled: boolean;
}

// Captions kept deliberately short AND deliberately sparse:
//  - CTA states ("sign in", "tap to start", "tap to retry") → show text
//    so the user knows what to do.
//  - Transitional / waiting states ("connecting", "starting") → show a
//    very short hint so the pause doesn't feel broken.
//  - Live voice states (listening / user-speaking / processing /
//    ai-speaking) → NO text, the orb (bars, rings, speaker icon) is the
//    single source of truth. Keeps the UI quiet once the conversation
//    is actually happening.
const STATE_VIEWS: Record<AppState, StateView> = {
  "signed-out":     { caption: "Sign in",         disabled: false },
  authenticated:    { caption: "Tap to start",    disabled: false },
  connecting:       { caption: "Connecting",      disabled: true  },
  connected:        { caption: "Connecting",      disabled: true  },
  "auto-selecting": { caption: "Connecting",      disabled: true  },
  starting:         { caption: "Starting",        disabled: true  },
  listening:        { caption: "",                disabled: false },
  "user-speaking":  { caption: "",                disabled: false },
  processing:       { caption: "",                disabled: false },
  "ai-speaking":    { caption: "",                disabled: false },
  error:            { caption: "Tap to retry",    disabled: false },
};

// Every state maps one-to-one to a CSS class so the stylesheet can swap
// the orb's colour theme and pick which indicator (icon / spinner / bars)
// to reveal. Keep in sync with `.circle.state-*` selectors in style.css.
const STATE_CLASS: Record<AppState, string> = {
  "signed-out": "state-signed-out",
  authenticated: "state-authenticated",
  connecting: "state-connecting",
  connected: "state-connected",
  "auto-selecting": "state-auto-selecting",
  starting: "state-starting",
  listening: "state-listening",
  "user-speaking": "state-user-speaking",
  processing: "state-processing",
  "ai-speaking": "state-ai-speaking",
  error: "state-error",
};

// States that represent an active voice session - used to toggle the
// mic / stop side controls and the "live" wrap class.
const LIVE_STATES: ReadonlySet<AppState> = new Set([
  "listening",
  "user-speaking",
  "processing",
  "ai-speaking",
  "starting",
]);

// ─── DOM refs ───────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(selector: string): T => {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
};

/**
 * Re-resolve a DOM ref if the cached one fell out of the live tree.
 *
 * The conversation markup is rendered by React via
 * `dangerouslySetInnerHTML`, so in steady state the inner nodes
 * survive every parent re-render. But the dev workflow (Vite HMR
 * + StrictMode) and a couple of edge cases on the React side
 * (parent unmount/remount that still calls into the engine before
 * its cleanup runs) can leave us holding a node that's been
 * replaced. Writes to a detached node *succeed* silently - the
 * `setState` log fires, but the user keeps seeing the stale
 * "Connecting" caption from the original markup.
 *
 * `ensureRef` is the cheapest insurance against that: a single
 * `isConnected` check on every UI-touching call, with a fallback
 * `querySelector` only when the cache is stale. It's a noop in
 * production builds (no HMR, no StrictMode unmount) and saves the
 * caption from getting orphaned in dev.
 */
const ensureRef = <T extends HTMLElement>(
  cached: T,
  selector: string,
): T => {
  if (cached.isConnected) return cached;
  const fresh = root.querySelector<T>(selector);
  return fresh ?? cached;
};

let circleBtn = $<HTMLButtonElement>("#main-circle");
let circleCaption = $<HTMLParagraphElement>("#circle-caption");
const toolToast = $<HTMLElement>("#tool-toast");
const toolToastText = toolToast.querySelector<HTMLSpanElement>(".tool-toast-text")!;
const orbWrap = $<HTMLElement>(".orb-wrap");
const micBtn = $<HTMLButtonElement>("#mic-btn");
const stopBtn = $<HTMLButtonElement>("#stop-btn");
// Robot picker markup was removed in the mobile port: we're always on
// the same LAN as the Reachy we just paired via Bluetooth, so asking
// the user to "Choose a Reachy" from the HF central listing on top of
// that adds no value and only surfaces robots they may not own.
// `renderRobotList` now auto-selects the first robot it sees instead
// of rendering any UI, so these refs intentionally don't exist in the
// DOM anymore. Kept as local `null`s so the rest of the engine (state
// machine, doStart, …) stays a mechanical port of the Space app.
const robotPicker: HTMLElement | null = null;
const robotList: HTMLElement | null = null;
const hfUser = $<HTMLSpanElement>("#hf-user");
const hfAvatar = $<HTMLImageElement>("#hf-avatar");
const hfUserName = $<HTMLSpanElement>("#hf-user-name");

const settingsBtn = $<HTMLButtonElement>("#settings-btn");
const settingsModal = $<HTMLDialogElement>("#settings-modal");
const inputClientId = $<HTMLInputElement>("#hf-client-id");
const hfClientIdField = $<HTMLLabelElement>("#hf-client-id-field");
const inputApiKey = $<HTMLInputElement>("#openai-key");
const inputModel = $<HTMLInputElement>("#openai-model");
const inputVoice = $<HTMLSelectElement>("#openai-voice");
const inputInstructions = $<HTMLTextAreaElement>("#openai-instructions");
const restartBtn = $<HTMLButtonElement>("#restart-conversation");
const restartHint = $<HTMLElement>("#restart-hint");
const hfLogoutBtn = $<HTMLButtonElement>("#hf-logout");
const settingsForm = settingsModal.querySelector<HTMLFormElement>("form")!;
const settingsTabs = Array.from(
  settingsModal.querySelectorAll<HTMLButtonElement>(".tab"),
);
const settingsPanels = Array.from(
  settingsModal.querySelectorAll<HTMLElement>("[data-tab-panel]"),
);

type SettingsTab = "access" | "conversation";

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
let settings: Settings = loadSettings();

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

// Screen Wake Lock held for the duration of an active session. Prevents
// mobile / laptop browsers from throttling timers, suspending media, or
// sleeping the device mid-conversation. Released on teardown.
//
// Typed loosely: the Wake Lock API shipped later than our TS lib target.
let wakeLock: { release(): Promise<void> } | null = null;
// Set to true once we've hit a `NotAllowedError` (iframe without the
// `screen-wake-lock` permissions-policy allowance - HF Spaces default).
// Prevents spamming the console on every visibilitychange afterwards.
let wakeLockUnavailable = false;

// ─── UI rendering ───────────────────────────────────────────────────────

// Whether the user has muted the robot microphone for this session. We
// track it locally so the mic button can render its active variant and
// we can restore the state on re-connect.
let micMuted = false;

function setState(next: AppState): void {
  currentState = next;
  // Fire the external observer FIRST so watchers see every transition
  // even if the UI-update code below throws (unlikely, but we keep the
  // contract honest). We also don't guard against re-entrancy: the
  // callback is expected to be lightweight React state bookkeeping.
  if (onStateChange) {
    try {
      onStateChange(next);
    } catch (err) {
      console.warn("[conversation-engine] onStateChange threw:", err);
    }
  }
  const view = STATE_VIEWS[next];
  circleBtn = ensureRef(circleBtn, "#main-circle");
  circleBtn.disabled = view.disabled;
  circleBtn.className = `circle ${STATE_CLASS[next]}`;

  // Default caption comes from the state view; error state overrides it
  // with the real message via setCaption() below.
  if (next !== "error") {
    setCaption(view.caption);
  }

  // Side controls (mic / stop) fade in during a live session and disappear
  // everywhere else so the idle UI stays to a single bouncy orb.
  const live = LIVE_STATES.has(next);
  orbWrap.classList.toggle("live", live);
  micBtn.setAttribute("aria-hidden", live ? "false" : "true");
  stopBtn.setAttribute("aria-hidden", live ? "false" : "true");
  micBtn.tabIndex = live ? 0 : -1;
  stopBtn.tabIndex = live ? 0 : -1;

  // Robot picker is only relevant in the `connected` state (waiting for
  // a robot to pick). Any other state should keep it hidden.
  if (next !== "connected") {
    showRobotPicker(false);
  }

  // Keep the "Restart conversation" button in sync: only clickable when
  // there's actually a session running to restart.
  updateRestartAvailability();
}

/**
 * Enable / disable the "Restart conversation" button based on whether we
 * currently have a live session. Called on every state transition + once
 * on modal open so the hint reflects the up-to-date situation.
 */
function updateRestartAvailability(): void {
  const live = LIVE_STATES.has(currentState);
  restartBtn.disabled = !live;
  restartHint.hidden = live;
}

/**
 * Update the caption line under the orb.
 *
 *  - empty `text`      → the row fully collapses (via `.empty` class + no
 *                        text), so the orb stays optically centered.
 *  - `kind: "error"`   → paints it in the error accent.
 *  - `kind: "muted"`   → dims it for secondary hints.
 *
 * The default style is intentionally discreet (uppercase micro-label, no
 * glow accent) so the orb remains the primary focal point.
 */
function setCaption(text: string, kind: "" | "error" | "muted" = ""): void {
  const trimmed = text.trim();
  circleCaption = ensureRef(circleCaption, "#circle-caption");
  circleCaption.textContent = trimmed;
  circleCaption.className = `circle-caption${kind ? ` ${kind}` : ""}${trimmed ? "" : " empty"}`;
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

  if (!robots.length) {
    setCaption("Waiting for Reachy", "muted");
    return;
  }

  if (selectedRobotId) return;

  const picked = robots[0];
  selectedRobotId = picked.id;
  setState("auto-selecting");
  window.setTimeout(() => {
    if (currentState === "auto-selecting") void doStart();
  }, 300);
}

// Retained as a no-op so references elsewhere in the engine (defensive
// hide-on-state-change) don't need to be rewritten. Any remaining call
// site is now dead UI code.
function showRobotPicker(_show: boolean): void {
  void _show;
  void robotPicker;
  void robotList;
}

// ─── Settings modal ─────────────────────────────────────────────────────

/**
 * Open the settings panel. Optionally focuses a specific tab.
 *
 * Policy:
 *   - "access" is the landing tab for first-run / missing credentials.
 *   - "conversation" is where the prompt / voice / model live, plus the
 *     "Restart conversation" button that re-applies them to a running
 *     session.
 */
function openSettings(tab: SettingsTab = "access"): void {
  inputClientId.value = settings.hfClientId;
  inputApiKey.value = settings.apiKey;
  inputModel.value = settings.model;
  inputVoice.value = settings.voice;
  inputInstructions.value = settings.instructions;

  // Only show the HF client ID field when it's actually relevant: either
  // we're on localhost (no HF-injected clientId available), or the user
  // already has a custom one saved and might want to clear / edit it.
  const needsClientIdField =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    Boolean(settings.hfClientId);
  hfClientIdField.classList.toggle("hidden", !needsClientIdField);

  setSettingsTab(tab);
  updateRestartAvailability();
  settingsModal.showModal();
}

function setSettingsTab(tab: SettingsTab): void {
  for (const btn of settingsTabs) {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  }
  for (const panel of settingsPanels) {
    const isActive = panel.dataset.tabPanel === tab;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  }
}

for (const btn of settingsTabs) {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab as SettingsTab | undefined;
    if (tab) setSettingsTab(tab);
  });
}

settingsBtn.addEventListener("click", () => openSettings("access"));

settingsForm.addEventListener("submit", (event) => {
  const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "save") return;

  const previousClientId = settings.hfClientId;
  settings = {
    hfClientId: inputClientId.value.trim(),
    apiKey: inputApiKey.value.trim(),
    model: inputModel.value.trim() || DEFAULT_MODEL,
    voice: inputVoice.value || DEFAULT_VOICE,
    instructions: inputInstructions.value.trim() || DEFAULT_INSTRUCTIONS,
  };
  saveSettings(settings);

  // Re-create the robot SDK instance if the client ID changed (so the next
  // login uses the new OAuth app).
  if (settings.hfClientId !== previousClientId) {
    location.reload();
  }
});

// Restart the live OpenAI session with whatever is currently in the form
// (user may have edited the prompt / voice / model without hitting Save
// yet - we read from the inputs, save, then bounce the session).
restartBtn.addEventListener("click", async () => {
  if (!LIVE_STATES.has(currentState)) return;

  settings = {
    ...settings,
    model: inputModel.value.trim() || DEFAULT_MODEL,
    voice: inputVoice.value || DEFAULT_VOICE,
    instructions: inputInstructions.value.trim() || DEFAULT_INSTRUCTIONS,
  };
  saveSettings(settings);

  settingsModal.close();

  // Tear down the current session and immediately spin up a new one with
  // the same robot. We keep `selectedRobotId` around so doStart picks up
  // where we left off.
  try {
    await teardown();
    if (selectedRobotId) {
      await doStart();
    } else if (robot?.isAuthenticated) {
      setState("authenticated");
    }
  } catch (err) {
    onFatalError(err);
  }
});

hfLogoutBtn.addEventListener("click", () => {
  if (!robot) return;
  robot.logout();
  settingsModal.close();
  location.reload();
});

// ─── Click handler for the central circle ──────────────────────────────
//
// One tap, one forward move. There is never a "Connect" button and a
// separate "Start" button: the signed-in user taps once, we run the
// whole signaling → robot-pick → session-start pipeline behind the
// animated orb. The only exception is the 2-robot case, where we pause
// on the picker until the user picks one card.

circleBtn.addEventListener("click", async () => {
  try {
    switch (currentState) {
      case "signed-out":
        if (!robot) return;
        if (!settings.hfClientId && location.hostname === "localhost") {
          setCaption("Add HF client ID in settings", "error");
          openSettings();
          return;
        }
        await robot.login();
        // login() triggers a full page redirect; nothing else to do.
        return;

      case "authenticated":
        if (!settings.apiKey) {
          setCaption("Add OpenAI key in settings", "error");
          openSettings();
          return;
        }
        await doConnect();
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
});

// ─── Side controls (mic mute + stop) ────────────────────────────────────

micBtn.addEventListener("click", () => {
  if (!robot) return;
  micMuted = !micMuted;
  // The SDK's "mic muted" actually gates the OUTBOUND track sent to the
  // robot's speakers. Since we route OpenAI's audio there, muting =
  // the robot stops speaking. That's the right mapping for a "pause
  // the assistant" button.
  robot.setMicMuted(micMuted);
  micBtn.classList.toggle("muted", micMuted);
  micBtn.setAttribute("aria-label", micMuted ? "Unmute" : "Mute");
  micBtn.title = micMuted ? "Unmute" : "Mute";
});

stopBtn.addEventListener("click", async () => {
  await teardown();
  selectedRobotId = null;
  micMuted = false;
  micBtn.classList.remove("muted");
  // `teardown()` only runs `stopSession()` so the SDK is usually still
  // `connected` to the daemon afterwards: skip straight to the robot
  // picker (which will auto-select if there's a single one) instead of
  // forcing the user through a redundant "Tap to start" screen.
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
});

// ─── High-level flow steps ──────────────────────────────────────────────

async function doConnect(): Promise<void> {
  if (!robot) return;
  setState("connecting");
  try {
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

  if (!settings.apiKey) {
    setCaption("Add OpenAI key in settings", "error");
    openSettings();
    return;
  }

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

  // NB: waking the robot up is no longer this engine's job - the
  // mobile ConnectedScreen POSTs `/api/move/play/wake_up` over HTTP
  // as soon as the user lands on a live robot, which happens well
  // before any conversation is started (and fires even for users who
  // only open the Apps tab). Doing it here too would trigger the
  // animation a second time mid-conversation.

  // Mark the SDK / DataChannel as ready BEFORE deciding whether to
  // continue with the conversation parts. The mobile app gates the
  // conversation pipeline behind a "user clicked Start" UI flag (see
  // `handle.startConversation()`), so we may end up parking here with
  // a live DC and no antennas/OpenAI - that's the desired state during
  // the wake-up animation. `setSessionEstablished` flips so the host
  // can pick up where we left off when it flips the gate.
  setSessionEstablished(true);

  if (!convoActiveRequested) {
    // SDK + DC are up. Sit tight. Drop back to a non-transient
    // observer state so the React watchdog disarms (`starting` is in
    // its TRANSIENT_STATES set, and we'd trip the lazy heal +
    // user-facing "Robot unresponsive" CTA after a few seconds
    // otherwise). `connected` is the closest match: the SDK is
    // connected to central, the DC is up for the daemon proxy,
    // there's just no active conversation pipeline yet.
    setState("connected");
    // The host (ConversePanel) will call `handle.startConversation()`
    // once the user lands in the `live` view; that path resumes from
    // `runConversationParts()` below.
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
  conversationStarted = true;

  // If we're being called from the deferred-start path (host flipped
  // the `convoActive` gate after we parked in `connected`), the state
  // machine is currently in `connected`. Re-arm the "starting" UI so
  // the orb shows the spinner during the OpenAI handshake. If we got
  // here from the auto-start path, we're already in `starting` and
  // the call is a no-op.
  if (currentState === "connected") setState("starting");

  // Grab the robot's incoming audio track (the robot's microphone).
  const robotMicTrack = getRobotMicTrack(robot);
  if (!robotMicTrack) {
    conversationStarted = false;
    onFatalError(new Error("Could not find the robot's microphone track"));
    return;
  }

  startMicLevelMonitor(robotMicTrack);
  startAntennas();
  if (robot._pc) startTransportMonitor(robot._pc);

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
  const client = new OpenaiRealtimeClient({
    apiKey: settings.apiKey,
    model: settings.model,
    voice: settings.voice,
    instructions: settings.instructions,
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
  setCaption("Reconnecting", "muted");

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
      const ok = robot?.setHeadPose(roll, pitch, yaw) ?? false;
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
      const ok = robot?.setAntennas(right, left) ?? false;
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
 * Show a discreet pill under the orb when the model invokes a tool.
 * Not a log, not a chat: purely a "heads up, something just happened"
 * signal so the user can correlate the robot's physical action with a
 * spoken phrase. Auto-dismisses after a few seconds; rapid successive
 * calls just replace the current message.
 */
let toolToastTimer: number | null = null;
function showToolToast(text: string, durationMs = 2800): void {
  if (toolToastTimer !== null) {
    clearTimeout(toolToastTimer);
    toolToastTimer = null;
  }
  toolToastText.textContent = text;
  toolToast.classList.add("visible");
  toolToast.setAttribute("aria-hidden", "false");
  toolToastTimer = window.setTimeout(() => {
    toolToast.classList.remove("visible");
    toolToast.setAttribute("aria-hidden", "true");
    toolToastTimer = null;
  }, durationMs);
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
    robot.setAntennas(0, 0);
  }
}

/**
 * Temporarily lock the head on a named pose (so the wobbler doesn't fight
 * it), hold for ~1.2s, then release so the speech sway resumes.
 */
function applyToolHeadPose(pose: { roll: number; pitch: number; yaw: number }): void {
  if (!robot) return;

  robot.setHeadPose(pose.roll, pose.pitch, pose.yaw);

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

/**
 * Sample the robot's microphone to a set of CSS custom properties:
 *   --audio-level          smoothed normalized RMS in [0, 1]
 *   --bar0 .. --bar4       five log-spaced frequency-band levels in [0, 1]
 *
 * The overall RMS drives the breathing ring; the per-band levels drive
 * the 5 vertical bars inside the orb during `listening` / `user-speaking`.
 */
class MicLevelMonitor {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private raf = 0;
  // Time-domain buffer for RMS.
  private timeBuf: Float32Array<ArrayBuffer> | null = null;
  // Frequency-domain buffer for the per-band bars.
  private freqBuf: Uint8Array<ArrayBuffer> | null = null;
  private level = 0;
  private bands = [0, 0, 0, 0, 0];

  // 5 log-spaced bands over the first ~128 bins of a 1024-FFT @ 48 kHz
  // (~47 Hz per bin), covering the bulk of speech energy (~180 Hz to 6 kHz).
  private static readonly BAND_EDGES = [4, 8, 16, 32, 64, 128];
  private static readonly LOG1P_10 = Math.log1p(10);
  private static compress(v: number): number {
    return Math.log1p(v * 10) / MicLevelMonitor.LOG1P_10;
  }

  start(track: MediaStreamTrack): void {
    this.stop();
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);

    this.ctx = ctx;
    this.source = src;
    this.analyser = analyser;
    this.timeBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    this.freqBuf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));

    const rootStyle = document.documentElement.style;

    const tick = () => {
      const an = this.analyser;
      const tbuf = this.timeBuf;
      const fbuf = this.freqBuf;
      if (!an || !tbuf || !fbuf) return;

      // Overall RMS → --audio-level (unchanged).
      an.getFloatTimeDomainData(tbuf);
      let sum = 0;
      for (let i = 0; i < tbuf.length; i++) sum += tbuf[i] * tbuf[i];
      const rms = Math.sqrt(sum / tbuf.length);
      const boosted = Math.min(1, Math.pow(rms * 6, 0.7));
      const levelAttack = boosted > this.level ? 0.55 : 0.12;
      this.level += (boosted - this.level) * levelAttack;
      rootStyle.setProperty("--audio-level", this.level.toFixed(3));

      // Per-band levels → --bar0..--bar4.
      an.getByteFrequencyData(fbuf);
      const edges = MicLevelMonitor.BAND_EDGES;
      for (let b = 0; b < 5; b++) {
        const lo = edges[b];
        const hi = edges[b + 1];
        let bandSum = 0;
        for (let j = lo; j < hi; j++) bandSum += fbuf[j];
        const raw = MicLevelMonitor.compress(bandSum / (hi - lo) / 255);
        const bandAttack = raw > this.bands[b] ? 0.35 : 0.12;
        this.bands[b] += (raw - this.bands[b]) * bandAttack;
        rootStyle.setProperty(`--bar${b}`, Math.min(1, this.bands[b]).toFixed(3));
      }

      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    try {
      this.source?.disconnect();
      this.analyser?.disconnect();
      this.ctx?.close();
    } catch {
      // ignored
    }
    this.ctx = null;
    this.source = null;
    this.analyser = null;
    this.timeBuf = null;
    this.freqBuf = null;
    this.level = 0;
    this.bands = [0, 0, 0, 0, 0];
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--audio-level", "0");
    for (let b = 0; b < 5; b++) rootStyle.setProperty(`--bar${b}`, "0");
  }

  /**
   * Wake the AudioContext back up after the tab came out of background.
   * Safari + iOS in particular suspend contexts while hidden and don't
   * resume them on their own.
   */
  resumeAudio(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch((err) => {
        console.warn("[mic-level] audioCtx resume failed:", err);
      });
    }
  }
}

function startMicLevelMonitor(track: MediaStreamTrack): void {
  micLevel ??= new MicLevelMonitor();
  micLevel.start(track);
}

function stopMicLevelMonitor(): void {
  micLevel?.stop();
}

/**
 * Sample the OpenAI output (Reachy's voice) to a single CSS custom
 * property `--ai-audio-level` in [0, 1]. Drives the ai-speaking halo
 * (core scale + outer-ring ripple) in real time, so the orb pulses on
 * every syllable instead of running a fixed-timer animation.
 *
 * Also tracks when the audio goes silent for long enough that we can
 * confidently exit the ai-speaking state. The OpenAI `response.done`
 * event fires the moment the model finishes *generating*, but the
 * already-buffered audio may still be playing out of the speakers for
 * another few hundred milliseconds. `waitForSilence()` lets callers
 * defer the state transition until the voice has actually stopped.
 */
class AiLevelMonitor {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private raf = 0;
  private timeBuf: Float32Array<ArrayBuffer> | null = null;
  private level = 0;
  // Monotonic timestamp (performance.now) of the last tick where the
  // smoothed RMS was above the silence threshold.
  private lastActiveTs = 0;

  // A queued "wait for silence" callback. Fires after the monitor has
  // observed at least `quietMs` of continuous silence.
  private silenceWait: {
    quietMs: number;
    cb: () => void;
    maxWaitTimer: number | null;
  } | null = null;

  // Linear RMS threshold below which we consider the track silent.
  // ≈ -44 dBFS. Intentionally low so that soft syllables, trailing
  // vowels and breath sounds still register as "active": the user was
  // seeing the UI snap back to `listening` while Reachy was still
  // talking, which was caused by brief inter-word dips crossing a
  // too-aggressive threshold.
  private static readonly SILENCE_THRESHOLD = 0.006;

  start(track: MediaStreamTrack): void {
    this.stop();
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);

    this.ctx = ctx;
    this.source = src;
    this.analyser = analyser;
    this.timeBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    this.lastActiveTs = performance.now();

    const rootStyle = document.documentElement.style;

    const tick = () => {
      const an = this.analyser;
      const buf = this.timeBuf;
      if (!an || !buf) return;

      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);

      // Same attack/release shape as MicLevelMonitor so the two halos
      // feel like they belong to the same visual language.
      const boosted = Math.min(1, Math.pow(rms * 6, 0.7));
      const levelAttack = boosted > this.level ? 0.55 : 0.12;
      this.level += (boosted - this.level) * levelAttack;
      rootStyle.setProperty("--ai-audio-level", this.level.toFixed(3));

      const now = performance.now();
      if (rms > AiLevelMonitor.SILENCE_THRESHOLD) {
        this.lastActiveTs = now;
      } else if (this.silenceWait) {
        const quietFor = now - this.lastActiveTs;
        if (quietFor >= this.silenceWait.quietMs) {
          const { cb, maxWaitTimer } = this.silenceWait;
          this.silenceWait = null;
          if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
          try {
            cb();
          } catch (err) {
            console.warn("[ai-level] silence callback threw:", err);
          }
        }
      }

      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cancelSilenceWait();
    try {
      this.source?.disconnect();
      this.analyser?.disconnect();
      this.ctx?.close();
    } catch {
      // ignored
    }
    this.ctx = null;
    this.source = null;
    this.analyser = null;
    this.timeBuf = null;
    this.level = 0;
    document.documentElement.style.setProperty("--ai-audio-level", "0");
  }

  resumeAudio(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch((err) => {
        console.warn("[ai-level] audioCtx resume failed:", err);
      });
    }
  }

  /**
   * Call `cb` once the track has been silent for at least `quietMs`.
   * Replaces any previous pending wait. `maxWaitMs` is a safety
   * fallback: if the monitor never sees silence (e.g. music, a stuck
   * noise floor), we fire the callback anyway so the UI doesn't hang.
   */
  waitForSilence(quietMs: number, cb: () => void, maxWaitMs = 8000): void {
    this.cancelSilenceWait();
    const maxWaitTimer = window.setTimeout(() => {
      if (this.silenceWait?.cb === cb) {
        this.silenceWait = null;
        try {
          cb();
        } catch (err) {
          console.warn("[ai-level] max-wait callback threw:", err);
        }
      }
    }, maxWaitMs);
    this.silenceWait = { quietMs, cb, maxWaitTimer };
  }

  /** Drop any pending waitForSilence without firing the callback. */
  cancelSilenceWait(): void {
    if (!this.silenceWait) return;
    if (this.silenceWait.maxWaitTimer !== null) {
      clearTimeout(this.silenceWait.maxWaitTimer);
    }
    this.silenceWait = null;
  }
}

function startAiLevelMonitor(track: MediaStreamTrack): void {
  aiLevel ??= new AiLevelMonitor();
  aiLevel.start(track);
}

function stopAiLevelMonitor(): void {
  aiLevel?.stop();
}

// ─── Transport path monitor ────────────────────────────────────────────
//
// Inspects the robot peer connection's selected ICE candidate pair via
// `RTCPeerConnection.getStats()` and updates a badge in the topbar so we
// can see at a glance whether the audio actually stays on the LAN or is
// going out through the internet.
//
// WebRTC candidate types:
//   host   → direct LAN interface (best case on local WiFi)
//   srflx  → server-reflexive (STUN), direct P2P across NATs
//   prflx  → peer-reflexive (discovered via connectivity checks)
//   relay  → TURN relay (worst case, traffic flows through a 3rd party)

type TransportKind = "lan" | "direct" | "relay" | "checking";

let transportMonitor: TransportMonitor | null = null;

class TransportMonitor {
  private pc: RTCPeerConnection | null = null;
  private timer: number | null = null;
  private lastKind: TransportKind | null = null;
  // Last snapshot of cumulative byte counters so we can diff against the
  // next tick and compute a bitrate. -1 means "no prior sample yet".
  private prevBytesSent = -1;
  private prevBytesRecv = -1;
  private prevSampleTs = 0;

  start(pc: RTCPeerConnection): void {
    this.stop();
    this.pc = pc;
    this.show("checking");
    // 1.5 s strikes a decent balance: responsive enough that the bitrate
    // feels live, but infrequent enough that `getStats()` doesn't show up
    // on the main-thread profile.
    this.timer = window.setInterval(() => this.tick(), 1_500);
    window.setTimeout(() => this.tick(), 600);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pc = null;
    this.lastKind = null;
    this.prevBytesSent = -1;
    this.prevBytesRecv = -1;
    this.prevSampleTs = 0;
    const pill = root.querySelector<HTMLElement>("#transport-pill");
    if (pill) pill.classList.add("hidden");
    const bitrate = root.querySelector<HTMLElement>("#transport-bitrate");
    if (bitrate) bitrate.textContent = "";
  }

  private async tick(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      this.show(selectedTransportKind(stats));
      this.updateBitrate(stats);
    } catch (err) {
      console.warn("[transport] getStats failed:", err);
    }
  }

  private show(kind: TransportKind): void {
    if (kind === this.lastKind) return;
    this.lastKind = kind;

    const pill = root.querySelector<HTMLElement>("#transport-pill");
    const label = root.querySelector<HTMLElement>("#transport-label");
    if (!pill || !label) return;

    pill.classList.remove(
      "hidden",
      "transport-checking",
      "transport-lan",
      "transport-direct",
      "transport-relay",
    );
    pill.classList.add(`transport-${kind}`);

    const meta = TRANSPORT_LABELS[kind];
    label.textContent = meta.label;
    pill.title = meta.tooltip;
  }

  /**
   * Read cumulative `bytesSent` / `bytesReceived` from the currently
   * selected ICE candidate pair (or summed outbound/inbound RTP if no
   * pair exposes them) and convert the delta since the last tick into
   * a human-readable kbps / Mbps readout rendered in the pill.
   */
  private updateBitrate(stats: RTCStatsReport): void {
    const bitrateEl = root.querySelector<HTMLElement>("#transport-bitrate");
    if (!bitrateEl) return;

    let bytesSent = 0;
    let bytesRecv = 0;
    let nowTs = 0;

    // Prefer the selected candidate pair - it sees ALL traffic on the
    // robot pc (audio + data channel) without double-counting across
    // RTCP / RTCP-mux streams. Fall back to summing RTP streams if the
    // browser doesn't expose byte counts on the pair.
    let foundOnPair = false;
    stats.forEach((report) => {
      if (report.type !== "candidate-pair") return;
      const pair = report as RTCStatsWithCandidates & {
        bytesSent?: number;
        bytesReceived?: number;
        selected?: boolean;
        timestamp?: number;
      };
      const isSelected =
        pair.selected === true ||
        (pair.nominated === true && pair.state === "succeeded");
      if (!isSelected) return;
      if (typeof pair.bytesSent === "number" && typeof pair.bytesReceived === "number") {
        bytesSent = pair.bytesSent;
        bytesRecv = pair.bytesReceived;
        nowTs = pair.timestamp ?? performance.now();
        foundOnPair = true;
      }
    });

    if (!foundOnPair) {
      stats.forEach((report) => {
        const r = report as {
          type: string;
          bytesSent?: number;
          bytesReceived?: number;
          timestamp?: number;
        };
        if (r.type === "outbound-rtp" && typeof r.bytesSent === "number") {
          bytesSent += r.bytesSent;
          nowTs = r.timestamp ?? nowTs;
        } else if (r.type === "inbound-rtp" && typeof r.bytesReceived === "number") {
          bytesRecv += r.bytesReceived;
          nowTs = r.timestamp ?? nowTs;
        }
      });
    }

    if (!nowTs) nowTs = performance.now();

    const hasPrev = this.prevBytesSent >= 0 && this.prevBytesRecv >= 0;
    const dtMs = nowTs - this.prevSampleTs;

    if (hasPrev && dtMs > 100) {
      const dBytes =
        Math.max(0, bytesSent - this.prevBytesSent) +
        Math.max(0, bytesRecv - this.prevBytesRecv);
      const bps = (dBytes * 8_000) / dtMs; // bits / s
      bitrateEl.textContent = formatBitrate(bps);
    } else if (!hasPrev) {
      bitrateEl.textContent = "";
    }

    this.prevBytesSent = bytesSent;
    this.prevBytesRecv = bytesRecv;
    this.prevSampleTs = nowTs;
  }
}

/** Human-readable bps - picks the right unit and keeps one decimal. */
function formatBitrate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "";
  if (bps >= 1_000_000) {
    const mbps = bps / 1_000_000;
    return `${mbps.toFixed(mbps >= 10 ? 0 : 1)} Mbps`;
  }
  const kbps = bps / 1_000;
  return `${kbps.toFixed(kbps >= 100 ? 0 : 1)} kbps`;
}

const TRANSPORT_LABELS: Record<TransportKind, { label: string; tooltip: string }> = {
  checking: {
    label: "Connecting…",
    tooltip: "Gathering ICE candidates for the robot peer connection.",
  },
  lan: {
    label: "LAN",
    tooltip: "Audio flows directly on the local network (host candidates).",
  },
  direct: {
    label: "Direct",
    tooltip: "Direct peer-to-peer through NAT (STUN-discovered candidates).",
  },
  relay: {
    label: "Relayed",
    tooltip: "Audio is going through a TURN relay — expect more latency.",
  },
};

/**
 * Walk the RTCStatsReport and return a human-readable classification of
 * the selected ICE candidate pair. Returns `checking` when no pair has
 * been nominated yet.
 */
function selectedTransportKind(stats: RTCStatsReport): TransportKind {
  // Stats shape: `candidate-pair`s reference `local-candidate` and
  // `remote-candidate` entries by id. The "selected" pair is the one
  // marked nominated + succeeded (and ideally `selected === true`, but
  // that flag is only set by Chrome).
  let selectedPair: RTCStatsWithCandidates | null = null;
  const candidates = new Map<string, RTCIceCandidateStat>();

  stats.forEach((report) => {
    if (
      report.type === "local-candidate" ||
      report.type === "remote-candidate"
    ) {
      candidates.set(report.id, report as RTCIceCandidateStat);
    }
    if (report.type === "candidate-pair") {
      const pair = report as RTCStatsWithCandidates;
      const isSelected =
        (pair as { selected?: boolean }).selected === true ||
        (pair.nominated === true && pair.state === "succeeded");
      if (!isSelected) return;
      // Prefer the explicitly `selected` one if multiple look nominated.
      if (!selectedPair || (pair as { selected?: boolean }).selected) {
        selectedPair = pair;
      }
    }
  });

  if (!selectedPair) return "checking";
  const pair = selectedPair as RTCStatsWithCandidates;

  const local = pair.localCandidateId ? candidates.get(pair.localCandidateId) : undefined;
  const remote = pair.remoteCandidateId ? candidates.get(pair.remoteCandidateId) : undefined;

  const localType = local?.candidateType;
  const remoteType = remote?.candidateType;

  if (localType === "relay" || remoteType === "relay") return "relay";
  if (localType === "host" && remoteType === "host") return "lan";
  return "direct";
}

interface RTCIceCandidateStat {
  id: string;
  candidateType?: "host" | "srflx" | "prflx" | "relay";
}

interface RTCStatsWithCandidates {
  type: string;
  nominated?: boolean;
  state?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
}

function startTransportMonitor(pc: RTCPeerConnection): void {
  transportMonitor ??= new TransportMonitor();
  transportMonitor.start(pc);
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

async function acquireWakeLock(): Promise<void> {
  if (wakeLockUnavailable) return;
  const anyNav = navigator as Navigator & {
    wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> };
  };
  if (!anyNav.wakeLock) {
    wakeLockUnavailable = true;
    return;
  }
  if (wakeLock) return;
  try {
    wakeLock = await anyNav.wakeLock.request("screen");
  } catch (err) {
    // Most common: permissions-policy blocks it (HF Spaces iframes don't
    // allow `screen-wake-lock`). Once that's the case, retrying on every
    // visibilitychange just spams the console - remember and move on.
    const name = (err as { name?: string } | null)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      wakeLockUnavailable = true;
      console.info(
        "[main] Screen Wake Lock unavailable (permissions policy). Continuing without it.",
      );
    } else {
      console.warn("[main] wakeLock.request failed:", err);
    }
    wakeLock = null;
  }
}

async function releaseWakeLock(): Promise<void> {
  try {
    await wakeLock?.release();
  } catch {
    // ignored
  }
  wakeLock = null;
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
  const ok = robot.setAntennas(0, 0);
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

  // Reset the convo-gate bookkeeping so a subsequent
  // `connect → startSession → startConversation` cycle behaves
  // identically to the first one.
  conversationStarted = false;
  sessionEstablished = false;

  // NB: sleeping the robot is no longer this engine's job either.
  // ConnectedScreen's cleanup POSTs `/api/move/play/goto_sleep` over
  // HTTP whenever the user leaves the robot view, so motors get a
  // chance to rest even on paths that never went through a
  // conversation (e.g. Apps tab only, or forget-Wi-Fi). Keeping the
  // sleep here as well would make the robot play the animation
  // twice on a clean disconnect (once at session end, once on screen
  // unmount).

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
  // Prefer the short "Tap to retry" caption; stash the full message in a
  // tooltip so the user can still get the details on hover.
  circleCaption.title = message;
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
    micMuted = false;
    micBtn.classList.remove("muted");
    // Fall back to the pre-session screen rather than the picker; the
    // user can trigger a new run with a single tap.
    if (robot?.isAuthenticated) {
      setState("authenticated");
    } else {
      setState("signed-out");
    }
  });

  robot.addEventListener("disconnected", () => {
    showRobotPicker(false);
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

/**
 * Pick up a HuggingFace token passed via the URL fragment and move it to
 * `sessionStorage`, where the SDK's `authenticate()` expects to find it.
 *
 * This is the bridge that lets the mobile client (Reachy Mini mobile app)
 * embed this Space in an iframe despite `X-Frame-Options: SAMEORIGIN` on
 * `huggingface.co/login`: the mobile app already holds a valid token
 * (stored on the robot daemon via a Bluetooth-mediated OAuth flow), and
 * it appends it to the iframe URL as `#hf_token=...`. The fragment is
 * never sent over HTTP, so the token does not leak to the HF Space
 * backend or to intermediate proxies.
 *
 * We clear the fragment right after reading it so page reloads do not
 * keep the token visible in the address bar.
 */
function consumeTokenFromHash(): void {
  if (typeof window === "undefined" || !window.location.hash) return;
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(hash);
  } catch {
    return;
  }
  const token = params.get("hf_token");
  if (!token) return;

  try {
    sessionStorage.setItem("hf_token", token);
  } catch (err) {
    console.warn("[main] could not persist pre-seeded HF token:", err);
  }

  // Remove the `hf_token` fragment but keep any other hash params the
  // app or SDK might care about (theme, embedded, …).
  params.delete("hf_token");
  const remaining = params.toString();
  const cleanUrl =
    window.location.pathname +
    window.location.search +
    (remaining ? `#${remaining}` : "");
  try {
    window.history.replaceState(null, "", cleanUrl);
  } catch {
    // replaceState can fail on ancient browsers; non-fatal.
  }
}

async function boot(): Promise<void> {
  consumeTokenFromHash();

  robot = new window.ReachyMini({
    appName: "Reachy Mini Minimal Voice",
    clientId: settings.hfClientId || undefined,
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
    if (/clientId/i.test(message)) {
      setCaption("Add HF client ID in settings", "muted");
    }
  }

  if (authenticated) {
    // The SDK's `robot.username` is derived from OIDC's `name` claim,
    // which is the user's *full name* (e.g. "frere thibaud"), not the
    // HF handle. It's good enough as a placeholder, but we fetch the
    // real `preferred_username` + `picture` from `/oauth/userinfo`
    // below to show the correct handle and avatar.
    hfUserName.textContent = "@" + (robot.username ?? "");
    hfUser.classList.remove("hidden");
    void loadHfUserInfo();
    setState("authenticated");

    // Mobile fast path: if the ConversePanel pre-fetched the robot's
    // central peer id for us (via /api/hf-auth/central-robot-status
    // on the daemon), drive the flow all the way through to an open
    // voice session without a single tap. The user signed in upstream
    // already; the "Tap to start" state is just noise for an app
    // that already knows its robot.
    //
    // We gate on the OpenAI key so new users still hit the settings
    // nudge instead of silently failing at the Realtime handshake.
    if (preselectedRobotId && settings.apiKey) {
      void doConnect();
    }
  } else {
    hfUser.classList.add("hidden");
    clearHfUser();
    setState("signed-out");
  }
}

/**
 * Pull the logged-in user's handle + avatar from HF's OIDC userinfo
 * endpoint. We prefer this over `/api/users/{name}/overview` because
 * the SDK only exposes the user's *display name* via `robot.username`
 * (the `name` claim), and names often contain spaces / accents that
 * break the `/api/users/...` path.
 *
 * Cached in `sessionStorage` so we don't re-hit the endpoint on every
 * tab visit.
 */
async function loadHfUserInfo(): Promise<void> {
  const token = sessionStorage.getItem("hf_token");
  if (!token) return;

  const cacheKey = "reachy.minimal.hfUserInfo";
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    try {
      const info = JSON.parse(cached) as HfUserInfo;
      applyHfUserInfo(info);
      return;
    } catch {
      sessionStorage.removeItem(cacheKey);
    }
  }

  try {
    const res = await fetch("https://huggingface.co/oauth/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      preferred_username?: string;
      picture?: string;
    };
    const info: HfUserInfo = {
      handle: data.preferred_username,
      picture: data.picture,
    };
    sessionStorage.setItem(cacheKey, JSON.stringify(info));
    applyHfUserInfo(info);
  } catch (err) {
    console.warn("[main] loadHfUserInfo failed:", err);
  }
}

interface HfUserInfo {
  handle?: string;
  picture?: string;
}

function applyHfUserInfo(info: HfUserInfo): void {
  if (info.handle) {
    hfUserName.textContent = "@" + info.handle;
  }
  if (info.picture) {
    setHfAvatar(info.picture);
  }
}

function setHfAvatar(url: string): void {
  hfAvatar.onload = () => hfAvatar.classList.add("loaded");
  hfAvatar.onerror = () => hfAvatar.classList.remove("loaded");
  hfAvatar.src = url;
}

function clearHfUser(): void {
  hfAvatar.classList.remove("loaded");
  hfAvatar.removeAttribute("src");
  sessionStorage.removeItem("reachy.minimal.hfUserInfo");
}

function whenReachyReady(): Promise<void> {
  if (window.ReachyMini) return Promise.resolve();
  return new Promise((resolve) => {
    window.addEventListener("reachymini:ready", () => resolve(), { once: true });
  });
}

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

// Strip the `booting` class once the browser has painted the initial
// layout — otherwise the orb visibly fades + scales in on first load
// because the `.ind` defaults (opacity 0, scale 0.85) differ from the
// state-applied values (opacity 1, scale 1). Two rAFs guarantee the
// first style commit has happened before we re-enable transitions.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    root.classList.remove("booting");
  });
});

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
const CENTRAL_SEND_URL = "https://cduss-reachy-mini-central.hf.space/send";
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
    // engine's UI lying about its current capabilities.
    if (sessionEstablished) setState("connected");
  },
};
} // end of mountConversation
