/**
 * Public types exposed by the conversation engine.
 *
 * Lifted out of `conversation-engine.ts` so the host (React panel,
 * session hook) can import them without dragging in the engine's
 * implementation. The runtime entrypoint (`mountConversation`) and
 * the engine internals stay in `conversation-engine.ts`.
 */

import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";

/**
 * Connection (transport) state machine.
 *
 * Owns the lifecycle of the SDK / WebRTC / DataChannel link to the
 * robot - the "is a robot physically reachable" question. It is
 * deliberately separate from `ConversationState` (the AI pipeline on
 * top): the connection can be `live` while no conversation runs, and
 * a conversation only exists while the connection is `live`.
 *
 * Hoisted to its own module so the React watchdog, the phase derivation
 * and the `onConnectionStateChange` observer can pattern-match on it
 * without duplicating the union.
 */
export type ConnectionState =
  | "signed-out"
  | "authenticated"
  | "connecting"
  | "connected"
  | "selecting"
  | "starting"
  /**
   * SDK + WebRTC + DataChannel are up, the wake-up trajectory has
   * been kicked off, motors are enabled - the robot is physically
   * "online". The conversation pipeline may or may not be running on
   * top (see `ConversationState`); `live` is purely the transport
   * statement "we hold a working session to this robot".
   *
   * `live` is its own state (rather than reusing `connected`) because
   * `connected` is the transient handshake state, whereas `live` is a
   * stable parking state the engine can sit in between conversations.
   */
  | "live"
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
 * Conversation (AI pipeline) state machine.
 *
 * Owns the lifecycle of the realtime backend + motion + tools that
 * sit ON TOP of a `live` connection. `idle` means the transport is up
 * but no AI side is running (the orb shows "tap to start"). Every
 * non-`idle` value only ever occurs while `ConnectionState === "live"`.
 */
export type ConversationState =
  /** No conversation running. The transport may be `live` (orb shows
   *  "tap to start") or not up at all. */
  | "idle"
  /** Conversation bring-up: HF realtime handshake + motion stack
   *  start, before the first `listening`. */
  | "starting"
  | "listening"
  | "user-speaking"
  | "processing"
  | "ai-speaking"
  /**
   * Transient wind-down entered the instant the user taps stop, BEFORE
   * the (deliberately gentle) pipeline teardown runs - the 700 ms
   * glide-to-neutral plus the realtime bridge close. Without it the orb
   * would keep showing the live conversation state for the whole
   * shutdown and the tap would feel laggy; here it flips to its spinner
   * immediately. Leaves for `idle` once the teardown settles.
   */
  | "stopping";

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
 * Live snapshot of the WebRTC transport used by the audio peer
 * connection. Bundled together so the host can render a single chip
 * (kind + bitrate + remote address) without having to wire three
 * separate callbacks.
 *
 * `bps` is the instantaneous bidirectional bitrate (bits per second).
 * It is `null` while ICE is still gathering or until we have two
 * samples to diff against; once the link is up the engine emits a
 * fresh value roughly every 1.5 s.
 *
 * `remoteIp` is the address of the selected remote ICE candidate -
 * effectively the robot's reachable address from this peer's point of
 * view. Useful in the session topbar for ad-hoc debug (SSH, `curl`,
 * …). Set to `null` when:
 *   - ICE hasn't nominated a pair yet (`kind === 'checking'`);
 *   - the transport is `relay` (the remote candidate is the TURN
 *     server, not the robot - misleading to expose);
 *   - the platform doesn't expose the candidate address (Safari).
 * It can also be a `*.local` mDNS hostname when host-candidate
 * privacy strips the literal IP (Chrome / Firefox default).
 */
export interface ConversationTransportInfo {
  kind: ConversationTransportKind;
  bps: number | null;
  remoteIp: string | null;
  /**
   * Rolling-min round-trip time on the selected candidate pair, in
   * milliseconds, or `null` when the platform doesn't expose it (iOS
   * WKWebView). Mirrors `TransportInfo.rttMs` from the
   * `TransportMonitor`. This is the link-QUALITY signal the topbar's
   * signal bars are driven by (latency, not bitrate); `kind` is shown
   * separately as a topology tag.
   */
  rttMs: number | null;
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
  /**
   * Visual intent of the toast. `"info"` (default) is the normal
   * "tool is running" pill; `"error"` is emitted when a tool call
   * fails (e.g. the camera capture behind `look` errored) so the
   * host can render it as a visible failure instead of a silent
   * disappearance.
   */
  variant?: "info" | "error";
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

/**
 * Sub-phase of the post-handshake bring-up (the connecting overlay's
 * "Wake-up" step). `wake` while the wake trajectory is awaited,
 * `finalize` while the stragglers settle (XVF3800 audio config +
 * daemon version read, which run concurrently with the wake but can
 * outlive it on a slow / older daemon). `null` outside the bring-up.
 * Lets the overlay say WHAT it's waiting on instead of holding one
 * opaque caption for up to ~10 s.
 */
export type ConversationBringUpPhase = 'wake' | 'finalize';

export interface ConversationEngineHandle {
  /** Tear down all listeners, audio analysers and WebRTC peer connections.
   *  Safe to call multiple times. */
  unmount: () => Promise<void>;
  /**
   * Activate the conversation parts (antennas oscillator, HF realtime
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
   * Restart the conversation parts in place: stop the current HF
   * realtime client + motion controllers, then bring them back up
   * with the latest settings. No-op when no conversation is running.
   *
   * The engine reads the active personality lazily (via
   * `composeInstructions` + the `voice` getter in `createHuggingFaceBridge`),
   * so a personality switch picks up the new instructions + voice
   * automatically on the next reconnect. The host calls this method
   * after mutating the personality store mid-session so the running
   * conversation reflects the new persona without the user having to
   * manually stop + start.
   *
   * The SDK / WebRTC tunnel stays up across the restart, so the
   * robot does not go to sleep and the daemon proxy keeps working.
   */
  restartConversation: () => Promise<void>;
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
   * In-place session recovery after a transport-level fatal error
   * (SDK re-dial gave up, data-channel death, failed reacquire). Same
   * bring-up path as `reacquireSession`, plus the wake dance: unlike
   * an iframe handoff the robot did NOT stay awake - the fatal
   * teardown (or the daemon's own idle reset) parked it in the sleep
   * pose - so recovery replays `wakeUp()`. On daemons with the wake
   * stand-down this is a silent no-op when the robot is still up.
   *
   * Failure routes back through the fatal-error path, so the host's
   * error view still renders when recovery cannot heal the session.
   *
   * The host passes its own robot identity because the engine's
   * selected id is nulled by the unsolicited-drop cleanup, AND
   * because the id itself may be dead: central peer ids change on
   * every daemon restart, so recovery re-resolves the dial target
   * (exact id if still listed, else a name match) against the
   * freshest robots snapshot, waiting a bounded time for a rebooting
   * robot to re-register.
   */
  recoverSession: (target: {
    robotId: string;
    robotName?: string | null;
  }) => Promise<void>;

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
   * Trigger a daemon self-update over the WebRTC data channel
   * (`{ type: 'start_update' }`, see pollen-robotics/reachy_mini#1208).
   *
   * Fire-and-ack: the daemon acks immediately, runs the PyPI update on
   * a background thread, then ends with a `systemctl restart` that
   * tears the transport down. No progress is streamed on this channel
   * - pair with `subscribeLogs` for live output and watch the session
   * drop to know the restart has begun.
   *
   * Returns `false` when the data channel isn't open (nothing sent).
   * Non-throwing. `preRelease` opts into pre-release builds.
   */
  startDaemonUpdate: (options?: { preRelease?: boolean }) => boolean;

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
   * Subscribe to the daemon's `journalctl -u reachy-mini-daemon`
   * stream over the WebRTC data channel. Thin pass-through to the
   * SDK's `subscribeLogs`. Returns an `unsubscribe()` callback that
   * is safe to call more than once.
   *
   * No-op (returns a noop unsubscribe) if the engine isn't mounted
   * or the DataChannel isn't open: the next viable engine boot will
   * NOT auto-resubscribe; consumers wire this to a hook that
   * re-runs whenever the session reaches `ready` again.
   *
   * The daemon batches lines aggressively - expect bursts of 5-50
   * lines at a time during noisy windows (app boot, motor PID
   * gains, etc). Consumers should append to a ring buffer rather
   * than replace state per call.
   */
  subscribeLogs: (options: {
    onLine: (entry: { timestamp: string; line: string }) => void;
    onError?: (error: string) => void;
  }) => () => void;

  /**
   * Raw SDK instance accessor, or `null` when the engine isn't live.
   * Escape hatch for surfaces that need low-level access not covered by
   * the dedicated pass-throughs (e.g. the first wake-up wizard reading the
   * robot mic track off `_pc` or replaying the wake-up trajectory).
   */
  getRobot: () => ReachyMiniInstance | null;

  /**
   * Bind the robot's video stream to a `<video>` element, replaying the
   * cached track if it already arrived. Returns a detach callback.
   */
  attachVideo: (videoElement: HTMLVideoElement) => () => void;
}

export interface ConversationEngineOptions {
  /**
   * Peer id the mobile app already knows for the specific Reachy the
   * user picked on the ScanScreen (from the central robot list).
   * When set, the engine takes a direct path instead of the Space
   * app's public flow:
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
   * Stable daemon-reported hardware id from the selected central robot
   * entry. This is attribution metadata for deployed realtime allocation;
   * it must not be confused with `preselectedRobotId`, which is an
   * ephemeral signaling peer id. Read lazily so reconnects can pick up a
   * central-listing enrichment without rebuilding the engine.
   */
  getRobotHardwareId?: () => string | null;

  /**
   * Gate consulted by the connection bring-up right before it wakes the
   * robot. When it returns `true`, the engine SKIPS the initial wake-up
   * and reaches `live` with the robot still asleep, leaving the very
   * first `wakeUp()` to the host's first-wake-up wizard (so its motor
   * step actually plays the wake trajectory instead of no-op'ing on an
   * already-awake robot).
   *
   * Evaluated fresh on every bring-up, so a host getter can flip between
   * sessions (wizard pending → defer; wizard already completed → wake as
   * usual). When `undefined`, bring-up always wakes the robot.
   */
  shouldDeferInitialWakeUp?: () => boolean;

  /**
   * Re-resolves the CURRENT central peer id for the selected robot,
   * called right before each `startSession()` (initial bring-up,
   * background re-arm, iframe reacquire). Returns `null` when it can't
   * (no stable `hardware_id`, central unreachable, no match), in which
   * case the captured `preselectedRobotId` is used as-is.
   *
   * Why: the robot's peer id rotates on every relay reconnect, so the
   * id captured upstream (end of BLE setup, a stale robot-list
   * snapshot) is frequently dead by the time we dial. Re-resolving by
   * the stable `hardware_id` makes the single connect attempt target
   * the live producer. When omitted, no re-resolution happens.
   */
  resolvePeerId?: () => Promise<string | null>;

  /**
   * Fires on every CONNECTION transition (`signed-out` → `connecting`
   * → `starting` → `live` → …). The React wrapper uses it to drive the
   * session phase + an external watchdog that flips the UI to "Robot
   * unresponsive - Retry" when we sit in a transient state
   * (`connecting`, `starting`, `selecting`) beyond a reasonable budget.
   *
   * Deliberately a single callback (not EventTarget) to keep the
   * engine's public surface minimal and because React's effect cleanup
   * is the natural disposal point: the wrapper wires it up on mount
   * and throws the callback away on unmount.
   *
   * Called synchronously from inside the connection FSM's `set()` so
   * the observer sees every transition in order, including fast ones
   * (e.g. `connected` → `selecting`) that happen within a single tick.
   */
  onConnectionStateChange?: (state: ConnectionState) => void;

  /**
   * Daemon version resolved as PART of the connection bring-up: emitted
   * once, just before the connection flips to `live`, so the host's
   * update gate can decide before the session UI is ever shown (no
   * post-connect "pop"). Bounded + fail-open on the engine side - `null`
   * means the read timed out / the daemon doesn't expose a version, which
   * keeps the gate dormant. Re-emitted after a post-update reboot when the
   * connection comes back up.
   */
  onDaemonVersionChange?: (version: string | null) => void;

  /**
   * Fires on every CONVERSATION transition (`idle` → `starting` →
   * `listening` → `user-speaking` → …). The React wrapper drives the
   * orb's live visual + the "conversation engaged" affordances from it.
   * Every non-`idle` value only occurs while the connection is `live`.
   */
  onConversationStateChange?: (state: ConversationState) => void;

  /**
   * When `true` (default), the engine auto-starts the full conversation
   * pipeline as soon as a robot is selected: open WebRTC session, start
   * the antennas oscillator, connect to HF realtime, wire the head
   * wobbler. This matches the public Space's "tap once → talking"
   * behaviour.
   *
   * When `false`, the engine still goes all the way through
   * `robot.startSession()` (so the WebRTC DataChannel that doubles as
   * the daemon proxy transport is up), but stops there. The conversation
   * parts (antennas, backend, wobbler) only fire when the host calls
   * `handle.startConversation()`.
   *
   * Used by the mobile app to keep the daemon tunnel alive during the
   * wake-up animation (the daemon proxy needs the DC) without animating
   * the antennas or using backend time until the user explicitly hits
   * "Start conversation".
   */
  autoStartConversation?: boolean;

  /**
   * Fires whenever the active ICE candidate pair classification changes
   * OR the measured bitrate moves by more than ~100 bps. The mobile
   * app uses it to render a live "kind + bitrate" badge in the session
   * topbar (e.g. `LAN  32 kbps`) without having to peek at internal
   * stats itself.
   *
   * Called once on session start with `{ kind: 'checking', bps: null }`,
   * then again on every distinct (kind, bitrate) tuple. The engine
   * itself owns the dedup. Cleared on `unmount()`.
   */
  onTransportChange?: (info: ConversationTransportInfo) => void;

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

  /**
   * Notifies the host as the post-handshake bring-up progresses
   * (see `ConversationBringUpPhase`). Fired with `'wake'` right
   * after `startSession` resolves, `'finalize'` once the wake
   * settled, and `null` when the connection reaches `live` (or the
   * bring-up aborts). The host refines the connecting overlay's
   * Wake-up caption with it.
   */
  onBringUpPhase?: (phase: ConversationBringUpPhase | null) => void;
}
