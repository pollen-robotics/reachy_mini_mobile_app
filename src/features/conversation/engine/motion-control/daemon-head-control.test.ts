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
    // be the first thing on the wire.
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
