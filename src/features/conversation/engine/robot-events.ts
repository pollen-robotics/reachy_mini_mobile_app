/**
 * SDK event wiring for the conversation engine.
 *
 * Lifted out of `conversation-engine.ts` so the engine's main file
 * stays focused on the FSM + orchestration. Listens to every SDK
 * event the engine cares about and translates them into:
 *
 *   - probe logs (`stateChanged`, `sessionStarted`, …) for handoff
 *     debug across the embedded conversation Space + mobile app
 *     consoles,
 *   - `renderRobotList` calls on `robotsChanged` (which itself does
 *     the auto-pick + auto-start dance),
 *   - the unsolicited-drop recovery path on `sessionStopped` (skipped
 *     when WE initiated the stop, via the session guard's
 *     `expectedStop` counter),
 *   - the video-track cache refresh on `videoTrack` (so late
 *     attachers from React don't miss the SDK's one-shot event),
 *   - state-machine transitions back to `authenticated` / `signed-out`
 *     on `disconnected`,
 *   - the transport-resilience side effects on the SDK's ICE +
 *     network events (`iceStateChange`, `networkOnline`,
 *     `networkOffline`, `networkChange`): degraded-mode enter/exit
 *     and the data-channel probe. The POLICY (what "degraded" means)
 *     lives behind the `deps` hooks - this file only translates
 *     events into hook calls.
 *
 * No state of its own: every mutable thing lives behind the `deps`
 * accessors. Single-call function (no factory / `dispose()`): the
 * SDK instance is recreated on every engine boot, so the listeners
 * naturally die with it.
 */

import type { RobotSession } from "@/features/robot-session/RobotSession";
import type {
  ReachyMiniInstance,
  RobotInfo,
} from "@/features/robot-session/sdk-types";
import type { ConnectionState } from "./types";

export interface WireRobotEventsDeps {
  /** SDK ref to wire. We require a non-null value here because the
   *  caller has just instantiated it in `boot()`. */
  robot: ReachyMiniInstance;
  /** Session layer the listeners read/write
   *  (`videoCache`, `guard`, `setKnownRobots`, …). */
  session: RobotSession;
  /** Closure-read flag for "engine is being torn down". The
   *  `disconnected` listener short-circuits when true so we don't
   *  fight the unmount path. */
  isUnmounted: () => boolean;
  /** Auto-pick + auto-start hook called from `robotsChanged`. */
  renderRobotList: (robots: RobotInfo[]) => void;
  /** Forwarded to the unsolicited-drop path so the host's mute
   *  side-button re-syncs to "unmuted" before we hand back. */
  applyMicMuted: (muted: boolean) => void;
  /** Drive the connection FSM directly for the `disconnected` event. */
  setConnectionState: (state: ConnectionState) => void;
  /** Fatal-error sink for the unsolicited-drop path. Awaited so the
   *  listener returns after the user-facing teardown completes. */
  onFatalError: (err: unknown) => Promise<void>;

  // ─── Transport-resilience hooks ───────────────────────────────────
  /** True while a conversation is in flight (`listening`,
   *  `user-speaking`, `processing`, `ai-speaking`). The resilience
   *  listeners only probe / gate during a live conversation - outside
   *  those states gating is either pointless or actively wrong (e.g.
   *  it would race the boot chain). */
  isConversationActive: () => boolean;
  /** Ping the robot data channel with a no-op command so `dc-health`
   *  can escalate a dead link to a fatal error. Fired on
   *  `networkOnline` / `networkChange` - transport swaps where ICE
   *  can stay nominally `connected` while the new path silently
   *  blackholes packets. */
  probeRobotLink: () => Promise<void>;
  /** Enter degraded mode (gate pose writes + mark the transport
   *  monitor as `checking`). Idempotence is the hook's business. */
  onTransportDegraded: (cause: string) => void;
  /** Exit degraded mode (ungate pose writes). No-op when we weren't
   *  degraded - again, the hook's business. */
  onTransportRecovered: (cause: string) => void;
}

export function wireRobotEvents(deps: WireRobotEventsDeps): void {
  const {
    robot,
    session,
    isUnmounted,
    renderRobotList,
    applyMicMuted,
    setConnectionState,
    onFatalError,
    isConversationActive,
    probeRobotLink,
    onTransportDegraded,
    onTransportRecovered,
  } = deps;

  const videoCache = session.videoCache;
  const sessionGuard = session.guard;

  // Global SDK probes: log every state-affecting event the central
  // pushes us so we can correlate handoff timing with what the SDK
  // actually saw on its SSE feed. Pure observability, no side
  // effects. Same probe set as the embedded conversation Space's
  // [doStart][probe] block - using the same vocabulary so a single
  // grep across both consoles shows the full handoff trace.
  //
  // Includes the resilience-pass events (`iceStateChange`,
  // `networkOnline`, `networkOffline`, `networkChange`) so a single
  // grep for `[shell-webrtc][probe]` surfaces both signaling-level
  // and transport-level transitions in causal order.
  for (const name of [
    "stateChanged",
    "sessionStarted",
    "sessionStopped",
    "sessionRejected",
    "peerStatusChanged",
    "iceStateChange",
    "networkOnline",
    "networkOffline",
    "networkChange",
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
    // Drop the cached video stream regardless of the source: a late
    // `attachVideo()` after a session ends should never replay a
    // dead track. The SDK's own `attachVideo` listener already nulls
    // any bound element's `srcObject` on this same event, so the
    // React side stays in sync without us touching the video element
    // directly here.
    videoCache.clear();

    // Distinguish stops we initiated from stops we're observing. See
    // the `expectedStop` counter for the full rationale; the short
    // version is: when WE called stopSession (release, teardown,
    // watchdog), the caller already owns its own follow-up (state,
    // motor mode, selectedRobotId clearing). Touching any of those
    // here would race the caller and corrupt the FSM - which is
    // exactly the bug that broke the apps-tab handoff in earlier
    // revisions.
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
    // (per-attempt timeout, libnice crash recovery, backend fatal,
    // mic introuvable, etc.): a full-screen `<SessionErrorView>` with
    // a single "Back" CTA that returns the user to the picker.
    //
    // This unifies the behaviour: every session-level failure is one
    // consistent surface with a clear way out, instead of leaving the
    // user stranded on `RobotSessionScreen` with the engine parked on
    // `authenticated` and the orb showing a misleading mid-bring-up
    // visual + a tiny "session ended" caption that's easy to miss. It
    // also keeps the cleanup deterministic: the next time the user
    // picks the same robot from the scan view, the engine remounts on
    // a fresh slate (motors disabled, no stale session reference, no
    // half-running realtime client).
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
  // mounted after the WebRTC negotiation already completed) can catch
  // up. The SDK's `videoTrack` event is one-shot per `startSession`,
  // so without this cache, anyone calling `attachVideo()` past the
  // negotiation window would never get a frame. Re-fires on every
  // reacquire too, so the cache always points at the live track.
  robot.addEventListener("videoTrack", (event) => {
    const detail = (
      event as CustomEvent<{ track: MediaStreamTrack; stream: MediaStream }>
    ).detail;
    videoCache.set(detail.stream);
    // Diagnostic line: surfaces in the mobile webview console so we
    // can tell whether the daemon is actually publishing video and
    // whether the cache picked it up. The SDK only fires this once per
    // `startSession` so the log is cheap.
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
    // here would just churn React state on a tree the host is already
    // unmounting. The unmount path doesn't rely on this listener for
    // any of its cleanup.
    if (isUnmounted()) return;
    if (robot.isAuthenticated) {
      setConnectionState("authenticated");
    } else {
      setConnectionState("signed-out");
    }
  });

  robot.addEventListener("error", (event) => {
    const detail = (
      event as CustomEvent<{ source: string; error: Error | string }>
    ).detail;
    console.error(`[robot:${detail.source}]`, detail.error);
  });

  // ─── Resilience hooks ────────────────────────────────────────────
  //
  // The SDK debounces `iceConnectionState === 'disconnected'` /
  // `'failed'` internally before surfacing an `error` event, and
  // forwards platform network signals as scoped events. A *real*
  // teardown still arrives as `error` / `sessionStopped`, which the
  // listeners above already route to `onFatalError`. What we DO from
  // these resilience signals is:
  //
  //   1. **Gate the pose dispatcher** while the link is degraded so
  //      the wobbler's 30 Hz writes don't pile up in the SCTP send
  //      buffer (which produces a jerk when the link comes back).
  //   2. **Mark the transport monitor as `checking`** so the UI's
  //      "we're streaming" indicator degrades immediately, without
  //      waiting for the next `getStats()` tick (which can stay
  //      stuck on stale, pre-degradation data for up to 1.5 s).
  //   3. **Probe the data channel** when the transport just changed
  //      underfoot (Wi-Fi → 4G, AP roam, network coming back) - ICE
  //      can stay nominally "connected" while the new path silently
  //      blackholes packets, so the probe (one neutral-antenna
  //      write) lets `dc-health` escalate to a fatal error in ~4 s
  //      instead of waiting for the next motion write to fail.
  //
  // (1) and (2) are implemented behind `onTransportDegraded` /
  // `onTransportRecovered` in the connection controller.

  // ICE transitions drive degraded mode deterministically. The SDK's
  // grace window already absorbs the *escalation to fatal*; this
  // listener is about the user-visible "we're not actually streaming
  // right now" state during the grace window, not about teardown.
  robot.addEventListener("iceStateChange", (event) => {
    const detail = (event as CustomEvent<{ state: RTCIceConnectionState }>)
      .detail;
    if (detail.state === "disconnected" || detail.state === "failed") {
      if (isConversationActive()) onTransportDegraded(`ice=${detail.state}`);
      return;
    }
    if (detail.state === "connected" || detail.state === "completed") {
      onTransportRecovered(`ice=${detail.state}`);
    }
  });

  // `offline` is deterministic - the OS / browser just told us the
  // network is gone. Gate writes immediately; ICE will follow within
  // seconds and the SDK's debounce takes over for the fatal escalation.
  robot.addEventListener("networkOffline", () => {
    if (isConversationActive()) onTransportDegraded("network=offline");
  });

  // `online` is the cheap "are we back?" signal. Ungate writes
  // optimistically (if the path is still dead, dc-health will catch
  // it via the probe) and verify the DC is reachable.
  robot.addEventListener("networkOnline", () => {
    onTransportRecovered("network=online");
    if (isConversationActive()) {
      void probeRobotLink();
    }
  });

  // `change` fires on transport-class swaps (Wi-Fi → 4G, 4G → Wi-Fi,
  // captive-portal sign-in). `online` typically does NOT fire in those
  // cases because the navigator never went fully offline - hence the
  // dedicated probe. We do NOT gate writes here: the transport changed
  // but it didn't *go away*, and gating would needlessly mute the
  // robot during a brief roam. The probe still gives us a fast
  // escalation if the new path is actually dead.
  robot.addEventListener("networkChange", () => {
    if (isConversationActive()) {
      void probeRobotLink();
    }
  });
}
