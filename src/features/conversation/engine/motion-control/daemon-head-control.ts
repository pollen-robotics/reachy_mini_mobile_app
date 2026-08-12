/**
 * Daemon-side head behaviour: face tracking + speech wobble.
 *
 * Both are daemon primitives carried on the robot data channel
 * (`set_head_tracking`, `set_wobbling`, `set_speech_offsets`). We drive
 * them from here rather than animating the head from the app, because
 * of the order in which the daemon composes the head target: it takes
 * the pose the app sent, blends it toward the tracking aim by `weight`,
 * THEN adds the speech offsets. At weight 1 the app's own pose writes
 * are discarded outright, so an app-side wobbler would be invisible -
 * while the daemon's wobble, applied after the blend, always shows.
 *
 * The daemon wobble is also better synchronised than ours could be. It
 * taps the audio branch that feeds the speaker through a `sync=true`
 * appsink and schedules each hop at the buffer's PTS, i.e. the instant
 * the sound is really heard. The app could only assume a fixed delay,
 * which the 300 ms receive-side jitter buffer makes wrong.
 *
 * These are plain typed data-channel messages sent through `sendRaw`,
 * the same approach `host-handle.ts` takes for `start_update`: the npm
 * SDK has no dedicated helper for them, and the daemon understands the
 * wire shape regardless of the SDK build.
 *
 * Suspension
 * ──────────
 * Tracking has to yield whenever something else legitimately owns the
 * head: a tool-call pose ("look up"), a streamed choreography, or a
 * daemon trajectory (wake_up / goto_sleep). We drop the weight to 0 for
 * the duration, which parks the aim without tearing the detector down,
 * then restore it. Those gates are getters with no change notification,
 * so a slow reconcile loop watches them and only emits a command when
 * the wanted weight actually changes - roughly one message per
 * transition rather than a stream.
 *
 * Handoff on disable
 * ──────────────────
 * The daemon cuts the blend weight to 0 in a single control tick when
 * tracking is disabled (no ramp-down), so the composed head target
 * would jump from the tracking aim to the last app-streamed pose - a
 * visible lurch at conversation stop. `disable()` therefore pins the
 * app target to the head's CURRENT pose first (read from
 * `robotState.head`, kept fresh by holding a pose subscription for the
 * conversation), making the blend removal a no-op; the orchestrator's
 * `gotoNeutral` then does the actual eased landing.
 */

import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";
import { isTrajectoryPlaying } from "../trajectoryGate";
import { createUnthrottledInterval } from "../../motion/unthrottled-interval";

/** Full tracking authority: the daemon owns the head orientation. */
const TRACKING_WEIGHT_ACTIVE = 1.0;
/** Parked: detection keeps running but the aim stops moving the head,
 *  handing it back to whatever the app streams. */
const TRACKING_WEIGHT_PARKED = 0.0;

/** How often we reconcile the wanted weight against the ownership
 *  gates. Slow on purpose: this only needs to catch transitions, and
 *  each one costs a single data-channel message. */
const RECONCILE_MS = 100;

/** Neutral head pose as the daemon's wire format wants it: a flat
 *  row-major 4x4 identity, matching what the pose dispatcher emits for
 *  RPY (0, 0, 0). */
const NEUTRAL_HEAD_MATRIX = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

const ZERO_SPEECH_OFFSETS = [0, 0, 0, 0, 0, 0];

export interface DaemonHeadControlDeps {
  /** Live SDK accessor. Every command is a no-op when null. */
  getRobot: () => ReachyMiniInstance | null;
  /** True while a tool-driven head pose is held by the tool-call
   *  handler's restore timer. Tracking parks so the head stays where
   *  the model put it. */
  isPoseLocked: () => boolean;
  /** True while a streamed choreography is playing. Tracking parks so
   *  the recorded frames reach the joints. */
  isMovePlaying: () => boolean;
  /** Forwarded to the data-channel health monitor, same sink the pose
   *  dispatcher reports to. */
  recordSend: (ok: boolean, where: string) => void;
}

export interface DaemonHeadControl {
  /** Hand the head to the daemon for the conversation: face tracking
   *  at full weight plus audio-reactive wobble. Starts the reconcile
   *  loop that parks tracking while the app owns the head. Idempotent. */
  enable: () => void;
  /**
   * Give the head back to the app: tracking off, wobble off, speech
   * offsets zeroed. Must run BEFORE any app-side landing animation -
   * while tracking holds full weight the daemon drops the app's pose
   * writes, so a glide would move nothing and the head would jump the
   * moment tracking went away. Idempotent.
   */
  disable: () => void;
  /**
   * Zero the speech offsets right now. The daemon schedules its hops
   * ahead of time against playback PTS, and an assistant turn cut
   * mid-word (barge-in) leaves the last scheduled offset applied with
   * nothing to decay it. This is the daemon-side equivalent of the
   * app wobbler's `reset()` on barge-in.
   */
  clearSpeechOffsets: () => void;
  /**
   * Ease the head to neutral entirely daemon-side, at 100 Hz, immune
   * to data-channel jitter. Replaces the app's frame-by-frame glide,
   * which had to fight both the Wi-Fi cadence and the tracking blend.
   * Fire-and-forget: it resolves once the daemon has been told, not
   * when the motion ends. No-op while another daemon move is running
   * (the daemon's move player refuses a second one), which in practice
   * means a teardown landing mid-choreography is skipped.
   */
  gotoNeutral: (durationMs: number) => void;
}

export function createDaemonHeadControl(
  deps: DaemonHeadControlDeps,
): DaemonHeadControl {
  let running = false;
  let reconcileTimer: { clear: () => void } | null = null;
  // Held for the whole conversation so `robotState.head` is current
  // (~30 Hz) when `disable()` needs it for the tracking handoff below.
  // Refcounted in the SDK, so it composes with the 3D mirror's own
  // subscription.
  let poseSubscribed = false;
  // What we believe the daemon is currently applying. Both are only
  // updated on an ACKNOWLEDGED send, so a command refused by a
  // not-yet-open data channel is retried by the next reconcile instead
  // of leaving the robot silently without tracking or wobble. `null`
  // weight means "never told it", so the first reconcile always sends.
  let sentWeight: number | null = null;
  let wobblingOn = false;

  const send = (cmd: unknown, where: string): boolean => {
    const robot = deps.getRobot();
    if (!robot || typeof robot.sendRaw !== "function") return false;
    try {
      const ok = robot.sendRaw(cmd);
      deps.recordSend(ok, where);
      return ok;
    } catch (err) {
      console.warn(`[daemon-head] ${where} failed:`, err);
      deps.recordSend(false, where);
      return false;
    }
  };

  /** Something other than the conversation owns the head right now. */
  const headBusyElsewhere = (): boolean =>
    deps.isPoseLocked() || deps.isMovePlaying() || isTrajectoryPlaying();

  const reconcile = (): void => {
    if (!running) return;
    const weight = headBusyElsewhere()
      ? TRACKING_WEIGHT_PARKED
      : TRACKING_WEIGHT_ACTIVE;
    if (
      sentWeight !== weight &&
      send(
        { type: "set_head_tracking", enabled: true, weight },
        "daemon-head-tracking",
      )
    ) {
      sentWeight = weight;
    }
    if (
      !wobblingOn &&
      send({ type: "set_wobbling", enabled: true }, "daemon-head-wobbling")
    ) {
      wobblingOn = true;
    }
  };

  return {
    enable() {
      if (running) return;
      running = true;
      sentWeight = null;
      wobblingOn = false;
      // Keep the pose stream flowing for the whole conversation so the
      // handoff in `disable()` has a CURRENT head pose to pin - a stale
      // one would send the head there, which is worse than no pin.
      const robot = deps.getRobot();
      if (robot && typeof robot.subscribePose === "function") {
        poseSubscribed = robot.subscribePose();
      }
      // The daemon answers `{"status": "unavailable"}` when it has no
      // camera to track with. `sendRaw` is fire-and-forget so we never
      // see that reply, and we deliberately don't care: wobbling is
      // audio-driven and stays working, so the robot still comes alive
      // while talking, it just doesn't follow a face.
      reconcile();
      reconcileTimer = createUnthrottledInterval(reconcile, RECONCILE_MS);
    },
    disable() {
      if (!running) return;
      running = false;
      reconcileTimer?.clear();
      reconcileTimer = null;
      sentWeight = null;
      wobblingOn = false;
      // Tracking handoff: pin the app-side target to the head's CURRENT
      // pose BEFORE pulling the blend. Disabling tracking zeroes the
      // daemon's blend weight in one control tick (`clear_tracking_aim`,
      // no ramp), so the composed target would otherwise jump from the
      // tracking aim straight to whatever the app last streamed - a
      // visible lurch. With the current pose pinned, removing the blend
      // changes nothing, and the caller's `gotoNeutral` does the actual
      // (eased) landing from here. Data-channel ordering guarantees the
      // pin lands before the tracking-off.
      const robot = deps.getRobot();
      const head = robot?.robotState?.head;
      if (head && head.length === 16) {
        send({ type: "set_target", head: [...head] }, "daemon-head-handoff");
      }
      send(
        { type: "set_head_tracking", enabled: false },
        "daemon-head-tracking",
      );
      // The daemon zeroes the offsets on `set_wobbling false` itself,
      // but it only does so when it still has a media server; asking
      // explicitly costs one message and removes the doubt.
      send({ type: "set_wobbling", enabled: false }, "daemon-head-wobbling");
      send(
        { type: "set_speech_offsets", offsets: ZERO_SPEECH_OFFSETS },
        "daemon-head-offsets",
      );
      if (poseSubscribed) {
        poseSubscribed = false;
        const r = deps.getRobot();
        if (r && typeof r.unsubscribePose === "function") r.unsubscribePose();
      }
    },
    clearSpeechOffsets() {
      if (!running) return;
      send(
        { type: "set_speech_offsets", offsets: ZERO_SPEECH_OFFSETS },
        "daemon-head-offsets",
      );
    },
    gotoNeutral(durationMs) {
      const robot = deps.getRobot();
      if (!robot || typeof robot.gotoTarget !== "function") return;
      try {
        robot.gotoTarget({
          head: NEUTRAL_HEAD_MATRIX,
          duration: durationMs / 1000,
        });
      } catch (err) {
        console.warn("[daemon-head] gotoNeutral failed:", err);
      }
    },
  };
}
