/**
 * Connection controller — the TRANSPORT layer of the Reachy session.
 *
 * Owns everything about WHEN a robot is live and nothing about the AI
 * conversation that runs on top. Extracted out of
 * `conversation-engine.ts` so the connection bring-up and the
 * conversation pipeline are two independent units that talk through a
 * narrow seam:
 *
 *   connection ──onConnectionLive()──▶ conversation  (maybe auto-start)
 *   connection ──onConnectionLost()──▶ conversation  (tear pipeline)
 *   conversation ──recordSend()─────▶ connection      (dc-health feed)
 *   conversation ◀──getRobot()────── connection       (LiveSession seam)
 *
 * What it owns
 * ────────────
 *   - the SDK `robot` ref (created in `boot()`, handed to the session);
 *   - the connection FSM transitions (`boot` → `doConnect` → `doStart`
 *     → `live`, plus `renderRobotList`, `teardown`, `onFatalError`);
 *   - the data-channel health monitor (`recordSend` / `probeRobotLink`);
 *   - the daemon-side motor-mode sync (reads BOTH FSMs);
 *   - the SDK event wiring (`robot-events.ts`);
 *   - the background-tab resilience (visibility re-arm + audio resume).
 *
 * What it deliberately does NOT own
 * ─────────────────────────────────
 *   - the conversation pipeline (HF realtime, motion, tools, audio):
 *     it only signals lifecycle via the injected `onConnectionLive` /
 *     `onConnectionLost` hooks;
 *   - the host-facing controls (`handleOrbClick`, `handleHostStop`):
 *     those coordinate both layers and stay in the engine orchestrator,
 *     delegating transport bits here.
 */

import type { ReachyMiniInstance, RobotInfo } from "@/features/robot-session/sdk-types";
import { CENTRAL_SIGNALING_URL } from "@/shared/env";
import { unlockIosMicForWebRtc } from "../permissions/iosMicUnlock";
import { applyAudioStartupConfig } from "./audio-startup-config";
import { consumeTokenFromHash, whenReachyReady } from "@/features/robot-session/token-hash";
import { createDcHealthMonitor } from "@/features/robot-session/dc-health";
import { installBackgroundResilience } from "@/features/robot-session/background-resilience";
import type { RobotSession } from "@/features/robot-session/RobotSession";
import { wireRobotEvents } from "./robot-events";
import { formatConversationError } from "./conversation-error";
import type { EngineCore } from "./engine-core";
import type { ConversationConnectionAttempt } from "./types";

export interface ConnectionControllerDeps {
  /** Shared engine state (connection + conversation FSMs + gates). The
   *  controller drives `core.connection` and reads `core.conversation`
   *  for the motor-mode sync. */
  core: EngineCore;
  /** Session layer (SDK boot, WebRTC handshake, wake/sleep, release). */
  session: RobotSession;
  /** Mobile single-robot fast path: the central peer id the host
   *  pre-selected on the scan screen. When set, `boot()` auto-connects
   *  and the background-resilience path re-arms on an unsolicited drop. */
  preselectedRobotId: string | null;
  /** Host-controlled gate consulted at bring-up. When it returns true,
   *  the initial `wakeUp()` is DEFERRED to the host: the first-wake-up
   *  wizard owns the wake so its motor step actually plays the trajectory
   *  (waking an already-awake robot is a daemon no-op). When false /
   *  omitted, bring-up wakes the robot as usual. Evaluated fresh on every
   *  `doStart` so a host getter can flip between sessions. */
  shouldDeferInitialWakeUp?: () => boolean;

  // ─── Observer plumbing ────────────────────────────────────────────
  /** Per-attempt progress for the host's "Connecting…" view. */
  emitConnectionAttempt: (info: ConversationConnectionAttempt | null) => void;
  /** Push a user-facing caption under the orb (null clears it). */
  emitErrorMessage: (message: string | null) => void;
  /** Surface the daemon version resolved during bring-up (just before
   *  `live`). `null` on a timed-out / unsupported read. */
  emitDaemonVersion: (version: string | null) => void;

  // ─── Conversation seam ────────────────────────────────────────────
  /** Connection reached `live`: the conversation layer decides whether
   *  to auto-start the AI pipeline. */
  onConnectionLive: () => Promise<void>;
  /** Connection going down: the conversation layer tears its pipeline
   *  (glide:false on the power-off path) and parks its FSM on `idle`. */
  onConnectionLost: (opts: { glide: boolean }) => Promise<void>;
  /** Resume the conversation's private AudioContexts on visibility
   *  return (wobbler + mic/ai level monitors). */
  resumeAudioContexts: () => void;
  /** Gate the robot mic forwarded to the backend. Used by the
   *  unsolicited-drop recovery path to re-sync the host's mute button. */
  applyMicMuted: (muted: boolean) => void;
  /** Gate / ungate the conversation's 30 Hz pose writes while the
   *  transport is degraded (SDK `iceStateChange === 'disconnected' |
   *  'failed'`, `networkOffline`). Wired by the engine to the motion
   *  orchestrator's send gate so degraded-link frames stay staged
   *  instead of piling up in the SCTP send buffer. */
  setPoseSendGate: (gated: boolean) => void;
}

export interface ConnectionController {
  /** Record the outcome of a motion send for the data-channel health
   *  monitor. The conversation's motion stack feeds this. */
  readonly recordSend: (ok: boolean, where: string) => void;
  /** Live SDK ref, or null in any pre-connect / torn-down state. The
   *  transport seam (`LiveSession`) wraps this. */
  getRobot(): ReachyMiniInstance | null;
  /** Null the SDK ref on unmount. */
  clearRobot(): void;
  /** Handle the central's `robotsChanged` snapshot (auto-pick +
   *  auto-start the selected robot). */
  renderRobotList(robots: RobotInfo[]): void;
  /** Open the SDK connection + drive straight through to a live
   *  session (the `authenticated → live` bring-up). */
  connect(): Promise<void>;
  /** Full transport teardown: stop pipeline (no glide) + goto-sleep +
   *  stopSession. */
  teardown(): Promise<void>;
  /** Classify + surface a fatal error, flip the connection FSM to
   *  `error`, and tear the session down. */
  onFatalError(err: unknown): Promise<void>;
  /** Kick the boot chain and install background-tab resilience. Call
   *  once, after the conversation pipeline is wired. Returns the boot
   *  promise (for the unmount guard) + the resilience disposer. */
  start(): { bootChain: Promise<void>; disposeBackgroundResilience: () => void };
}

// Version read during bring-up. The DataChannel proxy has been up for the
// whole wake-up by the time we read, so the first try almost always
// answers; we still allow a couple of cheap retries (the daemon proxy can
// briefly 404 right after the DC opens) and hard-bound the whole thing so a
// silent / unsupported daemon can NEVER stall the bring-up. Fail-open: a
// `null` result just leaves the update gate dormant.
const VERSION_BRINGUP_TIMEOUT_MS = 2_500;
const VERSION_BRINGUP_RETRY_MS = 250;

async function readDaemonVersionDuringBringUp(
  robot: ReachyMiniInstance,
  timeoutMs: number,
): Promise<string | null> {
  if (typeof robot.getVersion !== "function") return null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await robot.getVersion();
      if (typeof v === "string" && v.length > 0) return v;
    } catch (err) {
      console.warn("[shell-webrtc] getVersion during bring-up failed:", err);
    }
    if (Date.now() + VERSION_BRINGUP_RETRY_MS >= deadline) return null;
    await new Promise((r) => setTimeout(r, VERSION_BRINGUP_RETRY_MS));
  }
}

export function createConnectionController(
  deps: ConnectionControllerDeps,
): ConnectionController {
  const {
    core,
    session,
    preselectedRobotId,
    shouldDeferInitialWakeUp,
    emitConnectionAttempt,
    emitErrorMessage,
    emitDaemonVersion,
    onConnectionLive,
    onConnectionLost,
    resumeAudioContexts,
    applyMicMuted,
    setPoseSendGate,
  } = deps;

  const { connection, conversation } = core;
  const { unmounted } = core.gates;
  const setConnectionState = connection.set;
  const expectedStop = session.guard.expectedStop;

  // SDK ref. Created in `boot()`, handed to the session (the canonical
  // owner), kept here as the controller's working copy so the dozens
  // of `robot.X()` calls below stay terse.
  let robot: ReachyMiniInstance | null = null;

  // ─── Data-channel health ────────────────────────────────────────
  const dcHealth = createDcHealthMonitor({
    getRobot: () => robot,
    onFatalLink: (err) => {
      void onFatalError(err);
    },
  });
  const recordSend = dcHealth.recordSend;
  const probeRobotLink = dcHealth.probeRobotLink;

  // ─── Transport-degraded mode ────────────────────────────────────
  /**
   * True while a conversation is in flight. Shared by the resilience
   * listeners (probe / gate only mid-conversation) and the
   * background-resilience `onResume` hook below.
   */
  const isConversationActive = (): boolean => {
    const conv = conversation.current();
    return (
      conv === "listening" ||
      conv === "user-speaking" ||
      conv === "processing" ||
      conv === "ai-speaking"
    );
  };

  /**
   * Degraded-mode policy behind the `robot-events.ts` resilience
   * listeners. Entering gates the conversation's pose writes (so the
   * wobbler's 30 Hz frames stay staged instead of piling up in the
   * SCTP send buffer and jerking the robot on recovery) and snaps the
   * transport monitor to `checking` (so the topbar's signal bars
   * degrade immediately instead of on the next 1.5 s `getStats()`
   * tick). Exiting ungates the writes; the monitor re-classifies
   * itself on its next tick.
   *
   * The `degraded` flag is only for log hygiene / listener-storm
   * dedup - the underlying gate + monitor calls are idempotent.
   */
  let transportDegraded = false;
  const onTransportDegraded = (cause: string): void => {
    setPoseSendGate(true);
    session.markTransportChecking();
    if (!transportDegraded) {
      transportDegraded = true;
      console.info(`[connection] transport-degraded cause=${cause}`);
    }
  };
  const onTransportRecovered = (cause: string): void => {
    if (!transportDegraded) return;
    transportDegraded = false;
    setPoseSendGate(false);
    console.info(`[connection] transport-recovered cause=${cause}`);
  };

  // ─── Auto re-dial policy ────────────────────────────────────────
  /**
   * Behind the `robot-events.ts` `sessionReconnecting` /
   * `sessionReconnected` listeners (SDK `autoReconnect: true`).
   *
   * During a re-dial the transport is down BY DESIGN for up to ~20 s:
   * dc-health must not count the failing writes (it would escalate to
   * a fatal error and tear the session down mid-recovery), the pose
   * dispatcher must stage instead of send, and the user needs an
   * honest caption. We deliberately do NOT touch the connection FSM:
   * the engine's invariants tie the conversation FSM to `live`, and
   * the conversation pipeline (HF realtime websocket) survives the
   * re-dial just fine - only the robot leg is being rebuilt.
   *
   * On success the daemon serves a FRESH session: the motor-mode
   * dedup cache is stale (the new session never saw our `enabled`),
   * so it is cleared and re-synced. The video path heals itself via
   * the SDK's `videoTrack` re-fire + the cache listener.
   */
  const onSessionReconnecting = (detail: {
    attempt: number;
    maxAttempts: number;
    cause: string;
  }): void => {
    console.info(
      `[connection] session-reconnecting attempt=${detail.attempt}/` +
        `${detail.maxAttempts} cause=${detail.cause}`,
    );
    dcHealth.setSuspended(true);
    onTransportDegraded(`redial:${detail.cause}`);
    emitErrorMessage("Reconnecting to your Reachy…");
  };

  const onSessionReconnected = (detail: { attempt: number }): void => {
    console.info(
      `[connection] session-reconnected attempt=${detail.attempt}`,
    );
    dcHealth.setSuspended(false);
    onTransportRecovered("redial");
    emitErrorMessage(null);
    // Fresh daemon session: forget the previous session's motor mode
    // so the dedup guard can't swallow the re-assert, then re-sync
    // (no-op unless the bring-up / conversation actually needs
    // motors right now).
    session.recordMotorMode(null);
    syncMotorMode();
  };

  // ─── Motor-mode sync ────────────────────────────────────────────
  /**
   * Sync the daemon-side motor mode to the current state of both FSMs,
   * with a dedup layer so we don't flood the data channel with redundant
   * `setMotorMode` calls (every conversation turn boundary would
   * otherwise fire one).
   *
   * Two regimes:
   *   - connection `starting` (WebRTC bring-up + wake-up) OR an active
   *     conversation (`starting`, `listening`, `user-speaking`,
   *     `processing`, `ai-speaking`) → `enabled`.
   *   - everything else (connection `live` between conversations,
   *     `released`, `error`, pre-session) → no-op.
   *
   * The teardown path drives `setMotorMode('disabled')` directly
   * after `gotoSleep` resolves; this helper deliberately stays out
   * of its way.
   */
  function syncMotorMode(): void {
    if (!robot || !session.isEstablished()) return;
    const conv = conversation.current();
    const motorsActive =
      connection.current() === "starting" ||
      conv === "starting" ||
      conv === "listening" ||
      conv === "user-speaking" ||
      conv === "processing" ||
      conv === "ai-speaking";
    if (!motorsActive) return;
    const mode = "enabled" as const;
    // Dedup: most conversation transitions all map to the same
    // `enabled` mode. Without this guard the engine would emit a
    // setMotorMode message on every turn boundary - redundant DC
    // writes that can interrupt the pose stream.
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

  // Driven by BOTH FSMs (connection bring-up needs motors, and so does
  // an active conversation). Registered after the orchestrator's
  // host-facing observers so the user-visible transition is already
  // fanned out by the time we hit the DataChannel.
  connection.subscribe(() => syncMotorMode());
  conversation.subscribe(() => syncMotorMode());

  // ─── robotsChanged → auto-pick + auto-start ─────────────────────
  /**
   * Handle the HF central's `robotsChanged` event.
   *
   * The mobile app always knows which specific robot to talk to before
   * the engine mounts, so we auto-select the first robot that appears
   * and let `doStart` drive the rest. If the list changes mid-session
   * we keep the currently selected robot.
   */
  function renderRobotList(robots: RobotInfo[]): void {
    session.setKnownRobots(robots);

    if (connection.current() !== "connected") return;
    if (!robots.length) return;
    const picked = session.pickFirstIfNone();
    if (!picked) return;
    setConnectionState("selecting");
    window.setTimeout(() => {
      if (connection.current() === "selecting") void doStart();
    }, 300);
  }

  // ─── High-level flow steps ──────────────────────────────────────
  async function doConnect(): Promise<void> {
    if (!robot) return;
    console.log("[shell-webrtc] doConnect: entering, robot.state =", robot.state);
    setConnectionState("connecting");
    try {
      // WebKit privacy quirk on iOS: get the LAN host candidates
      // flowing *before* the SDK's `connect()` (which immediately
      // starts ICE gathering). Also where Android first surfaces the
      // RECORD_AUDIO prompt. Idempotent.
      await unlockIosMicForWebRtc().catch(() => undefined);

      // The SDK refuses a second `connect()` when already connected /
      // streaming. Our stop button only tears the *session* down, so
      // the daemon WebRTC is still up afterwards and we must skip
      // `connect()` to avoid the "Already connected" throw.
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
      setConnectionState("connected");

      // Fast path (mobile): we already know which robot to talk to
      // from the scan selection, so skip the robotsChanged wait and
      // drive straight into startSession.
      if (preselectedRobotId) {
        session.setSelectedRobotId(preselectedRobotId);
        setConnectionState("selecting");
        await doStart();
        return;
      }

      // Classic path: replay the last robotsChanged snapshot and let
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

    // Backend connection is deliberately not part of `startSession()`:
    // that call opens the WebRTC DataChannel used by the daemon proxy
    // (`http_proxy` over DC), needed for daemon-status, wake / sleep
    // choreography, and bring-up watchdogs even before the user starts
    // talking. The HF websocket is opened lazily in the conversation
    // pipeline after the user starts the conversation.

    setConnectionState("starting");

    // NB: we deliberately do NOT call robot.stopSession() here as a
    // preemptive cleanup. The SDK plumbs stopSession into the SAME
    // session id that `robot.connect()` just established, so calling
    // it mid-handshake tears down our OWN just-created peer state and
    // central comes back with "Session ended before it could start".

    // Bring the WebRTC session up. `session.start()` wraps the retry
    // loop + per-attempt timeout + libnice-crash recovery; the
    // `expectedStop` semantics are baked in through the session guard.
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
    // wake-up here so the host's "Connecting" transition stays up for
    // the duration of the wake animation. The state machine doesn't
    // flip to `live` until motors are actually enabled and the head /
    // antennas have settled into their wake pose.
    //
    // EXCEPTION: when the host signals a pending first-wake-up wizard
    // (`shouldDeferInitialWakeUp()` → true), we deliberately SKIP the
    // bring-up wake and reach `live` with the robot still asleep. The
    // wizard's motor step then owns the very first `wakeUp()`, so the
    // user actually sees the head + antennas play their trajectory
    // (waking an already-awake robot is a daemon no-op, which is why the
    // motor test looked dead when bring-up had already woken it). The
    // wizard guarantees the robot ends up awake on finish / skip.
    if (shouldDeferInitialWakeUp?.()) {
      console.log(
        `[DIAG] doStart: deferring initial wake-up to host (first-wake-up ` +
          `wizard pending) at t+${Math.round(performance.now() - tDoStart0)}ms`,
      );
    } else {
      const tBeforeWake = performance.now();
      console.log(`[DIAG] doStart: about to await session.wakeUp() at t+${Math.round(tBeforeWake - tDoStart0)}ms`);
      await session.wakeUp();
      console.log(
        `[DIAG] doStart: session.wakeUp() resolved in ${Math.round(
          performance.now() - tBeforeWake,
        )}ms (total t+${Math.round(performance.now() - tDoStart0)}ms)`,
      );
    }

    // Apply the tuned XVF3800 audio-board parameters now that the
    // DataChannel is live. Best-effort: a missing audio board (Lite /
    // dev) just warns and returns false.
    if (robot) {
      await applyAudioStartupConfig(robot);
    }

    // Mark the SDK / DataChannel as ready. The mobile app gates the
    // conversation pipeline behind a "user clicked Start" UI flag, so
    // we may park here with a live DC and no antennas / backend -
    // that's the desired state during the wake-up animation.
    session.setEstablished(true);

    // Resolve the daemon version as the LAST bring-up step, before we
    // announce `live`. Emitting it now (while the connecting overlay is
    // still up) means the host's update gate can decide before the
    // session UI is ever painted - no jarring post-connect "pop". The
    // read is hard-bounded + fail-open so a slow / unsupported daemon
    // can't trap the user on the connecting screen.
    if (robot) {
      const version = await readDaemonVersionDuringBringUp(
        robot,
        VERSION_BRINGUP_TIMEOUT_MS,
      );
      emitDaemonVersion(version);
    }

    // SDK + DataChannel are up, wake-up was fired, motors are enabled:
    // the transport is `live`. Whether the AI side runs on top is a
    // separate (conversation) decision behind the seam.
    console.log(
      `[DIAG] doStart: setConnectionState("live") at t+${Math.round(performance.now() - tDoStart0)}ms`,
    );
    setConnectionState("live");

    // Connection reached `live`. Hand off to the conversation layer,
    // which owns the decision to auto-start the AI pipeline. The
    // connection bring-up no longer reaches into conversation
    // internals - it just announces that the transport is live.
    await onConnectionLive();
  }

  async function teardown(): Promise<void> {
    // Announce the connection is going down. The conversation seam
    // tears its pipeline WITHOUT glide here - `gotoSleep` below is
    // about to play its own head + antennas trajectory and a 700ms
    // ease-out would fight it on the bus - and parks the conversation
    // FSM on `idle` so every teardown caller inherits a clean
    // conversation cursor and only has to re-park the connection FSM.
    await onConnectionLost({ glide: false });

    // Capture the session flag BEFORE resetting it - we need it to
    // decide whether to run the goto-sleep dance below.
    const wasSessionEstablished = session.isEstablished();

    // Flip the session flag here so the next connect → startSession →
    // startConversation cycle starts from a clean slate.
    session.setEstablished(false);

    // Self-contained: play the goto-sleep trajectory + release motors
    // BEFORE we tear the WebRTC session. Sending the command after
    // `stopSession()` would race the data channel close.
    if (wasSessionEstablished && robot) {
      // `session.sleepAndDisable()` plays the goto-sleep trajectory,
      // hard-bounded by a JS timeout, then forces motor mode to
      // `'disabled'` deterministically. Both steps run BEFORE
      // `stopSession()` below so they land while the WebRTC
      // DataChannel is still up.
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
      // doesn't try to run its own (now redundant) cleanup path.
      await expectedStop(() => robot!.stopSession());
    }
  }

  async function onFatalError(err: unknown): Promise<void> {
    const detail = err instanceof Error ? err.message : String(err);
    // Log the raw detail for diagnosis, but surface only the honest,
    // classified copy to the orb caption - never the raw engine string.
    console.error("[main] error:", detail);
    setConnectionState("error");
    emitErrorMessage(formatConversationError(detail));
    await teardown();
  }

  // ─── Boot ───────────────────────────────────────────────────────
  // `consumeTokenFromHash()` reads the HF token from the URL fragment
  // for the legacy iframe deployment (no-op on bundled mobile);
  // `whenReachyReady()` waits for `window.ReachyMini` to be defined
  // (synchronous at module load on the bundled build).
  async function boot(): Promise<void> {
    consumeTokenFromHash();

    robot = new window.ReachyMini({
      appName: "Reachy Mini Mobile App",
      // No `clientId`: the SDK uses its own default, and the mobile
      // app handles HF OAuth itself.
      signalingUrl: CENTRAL_SIGNALING_URL,
      // Negotiate the audio tracks up front so the HF realtime bridge
      // has them ready when the user taps the orb to start.
      enableMicrophone: true,
      // Let the SDK re-dial an established session whose transport
      // died (ICE failure, network loss) instead of surfacing a
      // fatal error. The engine reacts to `sessionReconnecting` /
      // `sessionReconnected` (see the auto re-dial policy above);
      // ignored by SDK builds that predate the option.
      autoReconnect: true,
    });
    // Hand the SDK ref to the session so its lifecycle methods can use
    // it. The controller's local `robot` stays in sync; the session is
    // the canonical owner from here on.
    session.attachRobot(robot);
    wireRobotEvents({
      robot,
      session,
      isUnmounted: unmounted.get,
      renderRobotList,
      applyMicMuted,
      setConnectionState,
      onFatalError,
      isConversationActive,
      probeRobotLink,
      onTransportDegraded,
      onTransportRecovered,
      onSessionReconnecting,
      onSessionReconnected,
    });

    let authenticated = false;
    try {
      authenticated = await robot.authenticate();
    } catch (err) {
      // The HF hub SDK throws when it tries to read a cached token but
      // cannot resolve a clientId. Treat as "not signed in" rather
      // than crashing, and surface a helpful hint.
      console.warn("[main] authenticate() failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      if (/clientId/i.test(message)) {
        emitErrorMessage("Add HF client ID in settings");
      }
    }

    if (authenticated) {
      setConnectionState("authenticated");

      // Mobile fast path: if the host pre-fetched the robot's central
      // peer id, drive the flow forward without a single tap. The
      // DataChannel that `doConnect` opens is what makes the daemon
      // proxy reachable (daemon-status pill, wake/sleep, watchdogs).
      if (preselectedRobotId) {
        // Awaited (not fire-and-forget): the unmount path uses the
        // boot promise as a "boot still in flight" guard so it can
        // wait for `doStart`'s `robot.startSession()` to settle before
        // calling `robot.stopSession()`. `doConnect` swallows its own
        // errors via `onFatalError`, so awaiting here cannot throw.
        await doConnect();
      }
    } else {
      setConnectionState("signed-out");
    }
  }

  function start(): {
    bootChain: Promise<void>;
    disposeBackgroundResilience: () => void;
  } {
    // Captures the entire boot chain (`whenReachyReady → boot →
    // doConnect → doStart → robot.startSession + wake-up`) as a single
    // promise. `unmount()` awaits this (with a timeout) before tearing
    // down so we never call `robot.stopSession()` while
    // `robot.startSession()` is still mid-flight. The chain swallows
    // its own errors via `onFatalError`, so awaiting it cannot throw.
    const bootChain: Promise<void> = whenReachyReady()
      .then(async () => {
        if (unmounted.get()) return;
        await boot();
      })
      .catch((err) => {
        if (unmounted.get()) return;
        void onFatalError(err);
      });

    // Background-tab + page-hide resilience. The module owns the
    // listener install / dispose contract and the sendBeacon endSession
    // path; we wire up the `onResume` callback with whatever the live
    // session needs (resume audio analysers, probe the data channel).
    const disposeBackgroundResilience = installBackgroundResilience({
      getRobot: () => robot,
      centralSendUrl: `${CENTRAL_SIGNALING_URL}/send`,
      onResume: () => {
        if (isConversationActive()) {
          resumeAudioContexts();
          void probeRobotLink();
          return;
        }

        // Re-arm after an unsolicited drop. When the WebRTC transport
        // dies while we were backgrounded the SDK's `disconnected`
        // listener parks the FSM in `authenticated`. With a preselected
        // robot that resting state means "we lost a session we were
        // supposed to have": silently re-drive the bring-up so the orb
        // genuinely returns to `live`.
        //
        // Guards keep this from firing in any other situation:
        //   - `preselectedRobotId`        only the single-robot flow;
        //   - `connection === authenticated`  the post-drop resting
        //                                 state (NOT released/handoff,
        //                                 NOT bring-up, NOT a live convo);
        //   - `robot?.isAuthenticated`    we still hold a valid HF token;
        //   - `!session.isEstablished()`  the session really is gone, so
        //                                 `doConnect()` does a clean
        //                                 fresh connect.
        if (
          preselectedRobotId &&
          connection.current() === "authenticated" &&
          robot?.isAuthenticated &&
          !session.isEstablished()
        ) {
          void doConnect();
        }
      },
    });

    return { bootChain, disposeBackgroundResilience };
  }

  return {
    recordSend,
    getRobot: () => robot,
    clearRobot: () => {
      robot = null;
    },
    renderRobotList,
    connect: doConnect,
    teardown,
    onFatalError,
    start,
  };
}
