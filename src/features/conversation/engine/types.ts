/**
 * Public types exposed by the conversation engine.
 *
 * Lifted out of `conversation-engine.ts` so the host (React panel,
 * session hook) can import them without dragging in the engine's
 * implementation. The runtime entrypoint (`mountConversation`) and
 * the engine internals stay in `conversation-engine.ts`.
 */

/**
 * Engine state machine.
 *
 * Hoisted to its own module so the React watchdog and the
 * `onStateChange` observer can pattern-match on it without
 * duplicating the union.
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

/**
 * Alias kept for symmetry with the option-name `onStateChange`. Some
 * callers prefer `ConversationState` over `AppState` because the
 * former is less generic-sounding outside this file; both are the
 * same union, exported from the same place.
 */
export type ConversationState = AppState;

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
 * Per-attempt info emitted while `doStart` runs through its
 * connection-retry loop.
 *
 * Fired:
 *   - At the start of every attempt (so the host can update the
 *     connecting overlay if `attempt > 1`).
 *   - With `null` when we either succeed or give up (the host
 *     should clear any "retrying" hint at that point).
 *
 * Why expose this at all
 * ──────────────────────
 * The robot's daemon has a known intermittent failure mode where
 * libnice asserts inside the WebRTC ICE nomination
 * (`priv_conn_check_tick_stream_nominate`), kills the daemon
 * outright, and systemd takes ~13-16 s to bring it back up. Our
 * single-shot `startSession` would just time out and tell the user
 * "Robot did not respond" while the daemon was still rebooting.
 *
 * The retry loop survives that crash (waits long enough for systemd
 * to restart the daemon, then retries the handshake). For the user,
 * we want the connecting overlay to clearly say "Reconnecting…"
 * instead of staying stuck on the same caption for 25 s, so they
 * understand we're actively working on it.
 */
export interface ConversationConnectionAttempt {
  /** 1-indexed. `1` is the first attempt, `2` is the first retry. */
  attempt: number;
  /** Total number of attempts the engine will make before giving up. */
  maxAttempts: number;
}

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
  /**
   * Bind a `<video>` element to the robot's WebRTC video track.
   *
   * The SDK keeps the binding alive across release / reacquire
   * cycles: on `stopSession` the source is cleared, on the next
   * `videoTrack` event it picks up the new stream automatically.
   * Safe to call before the robot has connected - the listener
   * just sits and waits for the first track.
   *
   * @returns A detach function. Call on unmount to release the
   *   listeners and null the video element's `srcObject`.
   *
   * No-op (returns a no-op cleanup) if the engine has been
   * unmounted or the SDK instance hasn't been created yet.
   */
  attachVideo: (videoElement: HTMLVideoElement) => () => void;

  // ─── Audio volume controls ────────────────────────────────────────
  //
  // Thin pass-through to the underlying SDK's volume round-trips.
  // The engine holds the SDK instance so consumers don't have to
  // reach into it - they can keep talking to one handle.

  /** Get the robot's current speaker volume (0-100). Resolves to
   *  `null` when the platform has no volume control or the SDK
   *  isn't ready. Always non-throwing. */
  getSpeakerVolume: () => Promise<number | null>;
  /** Set the robot's speaker volume (0-100). Resolves with the
   *  applied value (which may differ if the daemon clamped it),
   *  or `null` on failure. Non-throwing. */
  setSpeakerVolume: (volume: number) => Promise<number | null>;
  /** Get the robot's current microphone input volume (0-100).
   *  Same `null` semantics as `getSpeakerVolume`. */
  getMicrophoneVolume: () => Promise<number | null>;
  /** Set the robot's microphone input volume (0-100). Same
   *  `null` semantics as `setSpeakerVolume`. */
  setMicrophoneVolume: (volume: number) => Promise<number | null>;

  /** Read the daemon's reported version string (e.g. `"1.5.1"`).
   *  Resolves to `null` when the data channel isn't open yet, when
   *  the SDK isn't bootstrapped, or when the daemon predates the
   *  `get_version` Cmd. Non-throwing. */
  getDaemonVersion: () => Promise<string | null>;

  /**
   * Latest measured microphone level in [0, 1], smoothed by the
   * engine's `MicLevelMonitor`. Updated every audio frame; consumers
   * are expected to read it from a `requestAnimationFrame` loop
   * (canvas viz, DoA indicator, …) so we never re-render React for
   * level changes. Returns `0` when the conversation isn't active.
   */
  getMicLevel: () => number;

  /**
   * Ask the daemon to play one of the bundled sound files on the
   * robot's speaker (e.g. `"wake_up.wav"`, `"count.wav"`). Mostly
   * used as audible feedback for UI actions that change something
   * the user can't otherwise hear (a fresh speaker volume, a
   * successful auth, …).
   *
   * Resolves to `true` when the command was queued onto the
   * DataChannel, `false` if the engine isn't ready or the DC is
   * down. Non-throwing.
   */
  playSound: (file: string) => boolean;

  /**
   * Push a head orientation target (roll/pitch/yaw in degrees) to the
   * robot. Thin pass-through to the SDK's `setHeadRpyDeg` -
   * non-blocking, no completion event. Returns `true` when the
   * command was queued onto the DataChannel, `false` if the engine
   * isn't ready or the DC is down. Non-throwing.
   *
   * Used by manual control surfaces (e.g. the mobile app's joystick
   * over the camera feed). The conversation pipeline routes through
   * the pose dispatcher instead, NOT via this method, so the two
   * paths can't fight: the dispatcher is silent while the
   * conversation is stopped, which is the only time manual control
   * is offered to the user.
   */
  setHeadRpyDeg: (rollDeg: number, pitchDeg: number, yawDeg: number) => boolean;
}

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
   * Where to write the audio-reactive CSS custom properties
   * (`--audio-level`, `--ai-audio-level`, `--bar0..--bar4`) at
   * display rate. The React orb passes its own root here so the
   * audio loop drives only that node's style, instead of polluting
   * `document.documentElement` (which used to leak across HMR /
   * StrictMode remounts).
   *
   * Two shapes accepted:
   *   - **Lazy getter (recommended)**: `() => HTMLElement | null`.
   *     The engine queries the function on every audio frame, so
   *     a panel remount that swaps the orb DOM is picked up
   *     automatically - no re-bind required. This is what the
   *     React mobile shell uses, since the panel can unmount on
   *     tab switches without dropping the engine.
   *   - **Element value (legacy)**: `HTMLElement | null`. Captured
   *     once at engine init. Fine for hosts that mount the orb
   *     for the lifetime of the engine, but stales if the DOM
   *     ever changes underneath.
   *
   * When `null` / omitted the engine writes nowhere - the host
   * gets the levels via `onLevels` if it cares.
   */
  audioLevelsTarget?: HTMLElement | null | (() => HTMLElement | null);

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

  /**
   * Notifies the host on each attempt of the connection-retry loop
   * inside `doStart()`. Fired with the attempt number on every try
   * (1-indexed), and with `null` once we either succeed or surface
   * a fatal error.
   *
   * The host renders a "Reconnecting… (2 of 2)" caption inside the
   * connecting overlay when `attempt > 1`. See
   * `ConversationConnectionAttempt` for the rationale.
   */
  onConnectionAttempt?: (attempt: ConversationConnectionAttempt | null) => void;
}
