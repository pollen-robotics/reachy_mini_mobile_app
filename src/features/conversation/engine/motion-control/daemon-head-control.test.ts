/**
 * Daemon head control - command sequence and ownership handover.
 *
 * The behaviours pinned here are the ones whose breakage is silent on
 * the app side but very visible on the robot:
 *
 *   - tracking must PARK while the app owns the head, otherwise the
 *     daemon discards the app's pose and tool gestures like "look up"
 *     do nothing at all;
 *   - teardown must hand the head back BEFORE anything animates it,
 *     for the same reason;
 *   - a command refused by a closed data channel must be retried, not
 *     assumed applied.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";
import { setTrajectoryPlaying } from "../trajectoryGate";
import {
  type DaemonHeadControl,
  createDaemonHeadControl,
} from "./daemon-head-control";

interface SentCmd {
  type: string;
  enabled?: boolean;
  weight?: number;
  offsets?: number[];
  head?: number[];
}

let sendRaw: ReturnType<typeof vi.fn>;
let recordSend: ReturnType<typeof vi.fn>;
let poseLocked: boolean;
let movePlaying: boolean;
let control: DaemonHeadControl;

beforeEach(() => {
  sendRaw = vi.fn().mockReturnValue(true);
  recordSend = vi.fn();
  poseLocked = false;
  movePlaying = false;
  setTrajectoryPlaying(false);
  control = createDaemonHeadControl({
    getRobot: () => ({ sendRaw }) as unknown as ReachyMiniInstance,
    isPoseLocked: () => poseLocked,
    isMovePlaying: () => movePlaying,
    recordSend,
  });
});

function sent(): SentCmd[] {
  return sendRaw.mock.calls.map((call) => call[0] as SentCmd);
}

function sentOfType(type: string): SentCmd[] {
  return sent().filter((cmd) => cmd.type === type);
}

describe("handing the head to the daemon", () => {
  it("enables tracking at full weight and turns the wobble on", () => {
    control.enable();

    expect(sentOfType("set_head_tracking")).toEqual([
      { type: "set_head_tracking", enabled: true, weight: 1 },
    ]);
    expect(sentOfType("set_wobbling")).toEqual([
      { type: "set_wobbling", enabled: true },
    ]);
    control.disable();
  });

  it("is idempotent: a second enable sends nothing more", () => {
    control.enable();
    const before = sendRaw.mock.calls.length;
    control.enable();

    expect(sendRaw.mock.calls.length).toBe(before);
    control.disable();
  });

  it("reports every send to the data-channel health monitor", () => {
    control.enable();

    expect(recordSend).toHaveBeenCalledWith(true, "daemon-head-tracking");
    expect(recordSend).toHaveBeenCalledWith(true, "daemon-head-wobbling");
    control.disable();
  });
});

describe("parking while the app owns the head", () => {
  it("starts parked when a tool pose is already held", () => {
    poseLocked = true;
    control.enable();

    // Weight 0 rather than `enabled: false`: the detector stays warm so
    // coming back is one cheap message.
    expect(sentOfType("set_head_tracking")).toEqual([
      { type: "set_head_tracking", enabled: true, weight: 0 },
    ]);
    control.disable();
  });

  it("starts parked while a choreography is streaming", () => {
    movePlaying = true;
    control.enable();

    expect(sentOfType("set_head_tracking")[0]?.weight).toBe(0);
    control.disable();
  });

  it("starts parked during a daemon wake / sleep trajectory", () => {
    setTrajectoryPlaying(true);
    control.enable();

    expect(sentOfType("set_head_tracking")[0]?.weight).toBe(0);
    control.disable();
    setTrajectoryPlaying(false);
  });
});

describe("giving the head back", () => {
  it("disables tracking BEFORE any landing can be requested", () => {
    control.enable();
    sendRaw.mockClear();
    control.disable();

    // The order is what matters: while tracking holds full weight the
    // daemon drops every head target it receives, so the disable has to
    // hit the wire before any landing (only the pose pin - see the
    // handoff suite below - may legitimately precede it).
    const types = sent().map((cmd) => cmd.type);
    expect(types[0]).toBe("set_head_tracking");
    expect(sent()[0]?.enabled).toBe(false);
    expect(types).toContain("set_wobbling");
    expect(types).toContain("set_speech_offsets");
  });

  it("zeroes the speech offsets so no residual tilt is left applied", () => {
    control.enable();
    sendRaw.mockClear();
    control.disable();

    expect(sentOfType("set_speech_offsets")).toEqual([
      { type: "set_speech_offsets", offsets: [0, 0, 0, 0, 0, 0] },
    ]);
  });

  it("is idempotent: a second disable sends nothing more", () => {
    control.enable();
    control.disable();
    const before = sendRaw.mock.calls.length;
    control.disable();

    expect(sendRaw.mock.calls.length).toBe(before);
  });
});

describe("tracking handoff (flicker guard)", () => {
  // The daemon zeroes the blend weight in ONE control tick on
  // `set_head_tracking false` - no ramp. If the app's streamed pose
  // differs from where tracking put the head, the target steps and the
  // head lurches. The guard: pin the CURRENT pose as the app target
  // first, so removing the blend changes nothing.
  const currentHead = [
    0.9, 0, 0.1, 0,
    0, 1, 0, 0.02,
    -0.1, 0, 0.9, 0,
    0, 0, 0, 1,
  ];
  let subscribePose: ReturnType<typeof vi.fn>;
  let unsubscribePose: ReturnType<typeof vi.fn>;
  let statefulControl: DaemonHeadControl;

  beforeEach(() => {
    subscribePose = vi.fn().mockReturnValue(true);
    unsubscribePose = vi.fn().mockReturnValue(true);
    statefulControl = createDaemonHeadControl({
      getRobot: () =>
        ({
          sendRaw,
          subscribePose,
          unsubscribePose,
          robotState: { head: currentHead },
        }) as unknown as ReachyMiniInstance,
      isPoseLocked: () => poseLocked,
      isMovePlaying: () => movePlaying,
      recordSend,
    });
  });

  it("pins the current head pose BEFORE pulling the blend", () => {
    statefulControl.enable();
    sendRaw.mockClear();
    statefulControl.disable();

    const types = sent().map((cmd) => cmd.type);
    expect(types.indexOf("set_target")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("set_target")).toBeLessThan(
      types.indexOf("set_head_tracking"),
    );
    expect(sentOfType("set_target")[0]?.head).toEqual(currentHead);
  });

  it("holds a pose subscription for the conversation so the pin is fresh", () => {
    statefulControl.enable();
    expect(subscribePose).toHaveBeenCalledTimes(1);
    expect(unsubscribePose).not.toHaveBeenCalled();

    statefulControl.disable();
    expect(unsubscribePose).toHaveBeenCalledTimes(1);
  });

  it("skips the pin when no current pose is known (never sends a stale target)", () => {
    // The default `control` stub exposes no robotState at all.
    control.enable();
    sendRaw.mockClear();
    control.disable();

    expect(sentOfType("set_target")).toEqual([]);
  });
});

describe("barge-in", () => {
  it("zeroes the offsets the cut assistant turn left scheduled", () => {
    control.enable();
    sendRaw.mockClear();
    control.clearSpeechOffsets();

    expect(sentOfType("set_speech_offsets")).toEqual([
      { type: "set_speech_offsets", offsets: [0, 0, 0, 0, 0, 0] },
    ]);
    control.disable();
  });

  it("stays quiet when the conversation isn't running", () => {
    control.clearSpeechOffsets();
    expect(sendRaw).not.toHaveBeenCalled();
  });
});

describe("refused sends", () => {
  it("does not treat a closed data channel as applied", () => {
    sendRaw.mockReturnValue(false);
    control.enable();

    expect(recordSend).toHaveBeenCalledWith(false, "daemon-head-tracking");
    // Nothing was acknowledged, so the next reconcile has to try again
    // rather than believe the robot is tracking.
    sendRaw.mockClear();
    sendRaw.mockReturnValue(true);
    control.disable();
    control.enable();
    expect(sentOfType("set_head_tracking").at(-1)).toEqual({
      type: "set_head_tracking",
      enabled: true,
      weight: 1,
    });
    control.disable();
  });

  it("survives a throwing transport", () => {
    sendRaw.mockImplementation(() => {
      throw new Error("data channel exploded");
    });

    expect(() => control.enable()).not.toThrow();
    expect(recordSend).toHaveBeenCalledWith(false, "daemon-head-tracking");
    control.disable();
  });
});
