/**
 * Pose dispatcher - coalesces head + antennas updates into a single
 * `set_full_target` message at a fixed rate, with backpressure-aware
 * throttling.
 *
 * Why this exists
 * ───────────────
 * The wobbler runs at 20 Hz on its own worker timer. The antennas
 * oscillator runs at 30 Hz on a SEPARATE worker timer. Without this
 * dispatcher each tick of either timer immediately fires a
 * standalone `set_full_target` over the data channel, so the daemon
 * sees ~50 messages / second arriving at uncoordinated phases:
 *
 *   t+0ms    setTarget(head=…)         <- wobbler
 *   t+5ms    setTarget(antennas=…)     <- antennas (almost in lockstep)
 *   t+38ms   setTarget(antennas=…)     <- antennas alone
 *   t+50ms   setTarget(head=…)         <- wobbler alone
 *   t+72ms   setTarget(antennas=…)     <- antennas alone
 *   …
 *
 * The Dynamixel trajectory player on the daemon interpolates between
 * consecutive commands; a variable inter-arrival gap produces
 * variable per-axis velocity, which reads as "saccadé" on the robot.
 *
 * What this does
 * ──────────────
 * Both controls call `setHead()` / `setAntennas()` whenever they
 * have a fresh value. The dispatcher buffers the latest in either
 * axis and ticks at a fixed rate (default 30 Hz), emitting ONE
 * `set_full_target` with whichever axes were updated since the
 * previous flush.
 *
 *   t+0ms    setHead, setAntennas, [flush] -> {head, antennas}
 *   t+33ms   setAntennas,          [flush] -> {antennas}
 *   t+66ms   setHead, setAntennas, [flush] -> {head, antennas}
 *   t+100ms  setAntennas,          [flush] -> {antennas}
 *   …
 *
 * Net send rate stays at ~30 Hz (caps at the dispatcher's tick),
 * head and antennas updates that arrive within the same window are
 * delivered atomically as one combined frame, and the daemon's
 * trajectory player gets a clean, predictable cadence.
 *
 * Backpressure
 * ────────────
 * Every flush peeks at the SCTP send buffer (`dc.bufferedAmount`).
 * If we're past `bufferedAmountThreshold` bytes, we skip the send
 * but KEEP the dirty flag so the next tick retries with the freshest
 * values. This self-throttles when the link degrades (Wi-Fi blip,
 * tab backgrounded, …) instead of letting the queue blow up and
 * delivering a burst once the link recovers.
 */

import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";
import { createUnthrottledInterval } from "../../motion/unthrottled-interval";

export interface PoseDispatcherDeps {
  /** Live SDK accessor. The dispatcher bails out when null. */
  getRobot: () => ReachyMiniInstance | null;
  /** Forward the outcome of every flushed send to the engine's
   *  data-channel health monitor. */
  recordSend: (ok: boolean, where: string) => void;
  /** Maximum bytes pending in the SCTP send buffer before we
   *  throttle. Defaults to 4096 (4 KB). Roughly 25-30 in-flight
   *  combined `set_full_target` frames. */
  bufferedAmountThreshold?: number;
  /** Tick rate for the coalesced flush. Defaults to 30 Hz. */
  tickHz?: number;
}

export interface PoseDispatcher {
  /** Buffer a head pose update. Coalesces with any other axis
   *  updates that land before the next dispatcher tick. Pose is
   *  expressed in degrees (RPY); the dispatcher converts to the
   *  daemon's wire format (flat 4×4 matrix) just before send. */
  setHead: (rollDeg: number, pitchDeg: number, yawDeg: number) => void;
  /** Buffer an antennas update in degrees. The dispatcher converts
   *  to radians (wire format) at flush time. */
  setAntennas: (rightDeg: number, leftDeg: number) => void;
  /** Start the periodic flush timer. Idempotent. */
  start: () => void;
  /** Stop the timer and drop any pending updates. */
  stop: () => void;
  /** Force an immediate flush, bypassing the next-tick wait. Used
   *  for the final frame of a glide animation that must land before
   *  a motor mode change downstream. */
  flushNow: () => void;
  /** Whether the most recent flush attempt was throttled by
   *  backpressure. Useful for instrumentation; not consumed by the
   *  engine today. */
  isThrottling: () => boolean;
  /**
   * Gate motion writes externally. When `gate === true`, every
   * subsequent `flushNow()` bails out BEFORE the network write
   * (exactly as the SCTP backpressure path does), but KEEPS the
   * staged head/antennas values pending so the next tick after
   * `setSendGate(false)` resumes with the freshest commands.
   *
   * Intended for transport degradation: when the engine observes
   * `iceStateChange === 'disconnected'` or `networkOffline`, it
   * gates the dispatcher so the wobbler's 30 Hz writes don't pile
   * up in the SCTP send buffer (and produce a jerk on the robot
   * once the link recovers). Ungated as soon as the path is
   * healthy again (`iceStateChange === 'connected' | 'completed'`
   * or `networkOnline`).
   *
   * Idempotent: gating an already-gated dispatcher is a no-op, same
   * for ungating an open one.
   */
  setSendGate: (gate: boolean) => void;
  /** Whether the dispatcher is currently gating writes via
   *  `setSendGate(true)`. Separate from `isThrottling()` so
   *  instrumentation can tell a deliberate gate (engine policy)
   *  from SCTP backpressure (link saturation). */
  isGated: () => boolean;
}

const DEFAULT_TICK_HZ = 30;
// Raised from 4 KB → 16 KB (2026-06) after observing the current
// daemon fall behind on `set_full_target` drain under sustained
// 30 Hz load: the SCTP send buffer would cross 4 KB within ~1 s of
// the user starting to speak, dc-health would log 40 consecutive
// `pose-dispatcher-backpressure` failures, and the engine would
// tear the session down before the daemon had a chance to catch
// up. 16 KB ≈ ~100 in-flight `set_full_target` frames, giving the
// daemon ~3 s of buffer at 30 Hz to recover from a transient CPU
// spike. Lower this back once the daemon-side receive loop is fixed.
const DEFAULT_BUFFERED_THRESHOLD_BYTES = 16384;

export function createPoseDispatcher(
  deps: PoseDispatcherDeps,
): PoseDispatcher {
  const tickHz = deps.tickHz ?? DEFAULT_TICK_HZ;
  const bufferedAmountThreshold =
    deps.bufferedAmountThreshold ?? DEFAULT_BUFFERED_THRESHOLD_BYTES;
  const periodMs = 1000 / tickHz;

  // Pending wire-format payloads, or null when no fresh update is
  // staged for that axis. Both can be set independently; the
  // flush combines whatever's non-null.
  let pendingHeadFlat: number[] | null = null;
  let pendingAntennasRad: [number, number] | null = null;
  let dirty = false;
  let timer: { clear: () => void } | null = null;
  let throttling = false;
  // External gate driven by the engine on transport degradation
  // (`iceStateChange === 'disconnected'` / `networkOffline`).
  // Separate from `throttling` so consumers can tell SCTP
  // backpressure from a deliberate gate.
  let gated = false;

  const setHead = (
    rollDeg: number,
    pitchDeg: number,
    yawDeg: number,
  ): void => {
    // Convert NOW so the next tick spends zero time on math even if
    // wobbler tick and dispatcher tick land in the same scheduler
    // microtask.
    pendingHeadFlat = rpyToMatrixFlat(rollDeg, pitchDeg, yawDeg);
    dirty = true;
  };

  const setAntennas = (rightDeg: number, leftDeg: number): void => {
    pendingAntennasRad = [degToRad(rightDeg), degToRad(leftDeg)];
    dirty = true;
  };

  const flushNow = (): void => {
    if (!dirty) return;
    const robot = deps.getRobot();
    if (!robot) return;

    // External gate (engine policy on transport degradation).
    // Same shape as the SCTP backpressure path below: bail BEFORE
    // the send, KEEP the dirty flag so the next tick after
    // ungating picks up the freshest staged values. We do NOT
    // touch `throttling`: that flag is reserved for actual
    // backpressure so instrumentation can tell the two apart.
    if (gated) {
      deps.recordSend(false, "pose-dispatcher-gated");
      return;
    }

    // Backpressure check on the SCTP send buffer. We peek at the
    // private `_dc` field of the SDK because the public surface
    // doesn't expose it. If the buffer is past threshold we
    // DELIBERATELY do NOT clear `dirty` - the freshest values stay
    // staged and the next tick will retry with them.
    const dc = (robot as unknown as { _dc?: RTCDataChannel | null })._dc;
    if (dc && dc.bufferedAmount > bufferedAmountThreshold) {
      throttling = true;
      deps.recordSend(false, "pose-dispatcher-backpressure");
      return;
    }
    throttling = false;

    const cmd: {
      type: "set_full_target";
      head?: number[];
      antennas?: [number, number];
    } = { type: "set_full_target" };
    if (pendingHeadFlat) cmd.head = pendingHeadFlat;
    if (pendingAntennasRad) cmd.antennas = pendingAntennasRad;

    // `sendRaw` returns false if the data channel is not open. We
    // honour that the same way: don't clear the dirty flag, so the
    // next tick (which might run after the channel is back up)
    // retries with the latest staged values.
    const ok = robot.sendRaw(cmd);
    deps.recordSend(ok, "pose-dispatcher");
    if (ok) {
      pendingHeadFlat = null;
      pendingAntennasRad = null;
      dirty = false;
    }
  };

  const start = (): void => {
    if (timer !== null) return;
    timer = createUnthrottledInterval(flushNow, periodMs);
  };

  const stop = (): void => {
    if (timer === null) return;
    timer.clear();
    timer = null;
    pendingHeadFlat = null;
    pendingAntennasRad = null;
    dirty = false;
    throttling = false;
    // Reset the engine-driven gate too: a fresh session shouldn't
    // inherit the previous session's gating state. The engine
    // re-arms the gate on the next degradation if needed.
    gated = false;
  };

  const isThrottling = (): boolean => throttling;

  const setSendGate = (gate: boolean): void => {
    gated = gate;
  };

  const isGated = (): boolean => gated;

  return {
    setHead,
    setAntennas,
    start,
    stop,
    flushNow,
    isThrottling,
    setSendGate,
    isGated,
  };
}

// ─── Wire-format helpers ────────────────────────────────────────────────
// Mirror the SDK's `rpyToMatrix` + `degToRad` (from
// `@pollen-robotics/reachy-mini-sdk`). Inlined here so the dispatcher can
// build the wire payload directly without going through the SDK's
// per-axis `setHeadRpyDeg` / `setAntennasDeg` wrappers (which would
// each emit their OWN `set_full_target`, defeating the whole point
// of coalescing).

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function rpyToMatrixFlat(
  rollDeg: number,
  pitchDeg: number,
  yawDeg: number,
): number[] {
  const r = degToRad(rollDeg);
  const p = degToRad(pitchDeg);
  const y = degToRad(yawDeg);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const cr = Math.cos(r);
  const sr = Math.sin(r);
  // Row-major flat 4×4 ZYX rotation matrix, identical to the
  // SDK's `rpyToMatrix(...).flat()`.
  return [
    cy * cp,
    cy * sp * sr - sy * cr,
    cy * sp * cr + sy * sr,
    0,
    sy * cp,
    sy * sp * sr + cy * cr,
    sy * sp * cr - cy * sr,
    0,
    -sp,
    cp * sr,
    cp * cr,
    0,
    0,
    0,
    0,
    1,
  ];
}
