import { describe, expect, it, vi } from 'vitest';

import {
  TELEPRESENCE_LIMITS,
  TelepresenceMotionController,
  flatMatrixToRpy,
  rpyToFlatMatrix,
  type MotionSink,
  type ReportedPose,
} from './motion-controller';

const RAD = 180 / Math.PI;

function makeRig(opts: { robotPose?: ReportedPose | null; canMove?: () => boolean } = {}) {
  // Decoded view of every `set_full_target` frame, in degrees.
  const calls: { head: number[][]; body: number[]; antennas: number[][]; frames: number } = {
    head: [],
    body: [],
    antennas: [],
    frames: 0,
  };
  const sink: MotionSink = {
    setTarget: ({ head, body_yaw, antennas }) => {
      calls.frames += 1;
      if (head) {
        const { roll, pitch, yaw } = flatMatrixToRpy(head);
        calls.head.push([roll, pitch, yaw]);
      }
      if (body_yaw !== undefined) calls.body.push(body_yaw * RAD);
      if (antennas) calls.antennas.push([antennas[0] * RAD, antennas[1] * RAD]);
      return true;
    },
  };
  const deflection = { x: 0, y: 0 };
  const ctrl = new TelepresenceMotionController({
    getSink: () => sink,
    getDeflection: () => deflection,
    getRobotPose: () => opts.robotPose ?? null,
    canMove: opts.canMove,
  });
  const run = (ticks: number) => {
    for (let i = 0; i < ticks; i++) ctrl.tick(0.05);
  };
  return { ctrl, calls, deflection, run };
}

describe('rpy <-> matrix', () => {
  it('round-trips', () => {
    const rpy = flatMatrixToRpy(rpyToFlatMatrix(10, -20, 35));
    expect(rpy.roll).toBeCloseTo(10);
    expect(rpy.pitch).toBeCloseTo(-20);
    expect(rpy.yaw).toBeCloseTo(35);
  });
});

describe('TelepresenceMotionController', () => {
  it('sends nothing until the operator touches a control', () => {
    const { calls, run } = makeRig();
    run(40);
    expect(calls.frames).toBe(0);
  });

  it('push right looks right (yaw decreases), push up looks up (pitch decreases)', () => {
    const { ctrl, deflection, run } = makeRig();
    deflection.x = 1;
    deflection.y = -1;
    run(5);
    const pose = ctrl.getPose();
    expect(pose.headYawRel).toBeLessThan(0);
    expect(pose.pitch).toBeLessThan(0);
  });

  it('sends head and body in the same frame', () => {
    const { calls, deflection, run } = makeRig();
    deflection.x = 0.5;
    run(3);
    expect(calls.head.length).toBe(calls.body.length);
    expect(calls.head.length).toBeGreaterThan(0);
  });

  it('drags the base once the head is pinned at its leash, and the base target follows', () => {
    const { ctrl, deflection, run } = makeRig();
    deflection.x = -1; // look left: yaw increases
    run(60); // 3 s at 60°/s saturates the 60° leash after ~1 s
    const pose = ctrl.getPose();
    expect(pose.headYawRel).toBe(TELEPRESENCE_LIMITS.headYawRelDeg);
    expect(pose.bodyYaw).toBeGreaterThan(0);
    expect(ctrl.getSnapshot().targets.bodyYaw).toBe(pose.bodyYaw);

    // Releasing the stick leaves the base where it is.
    deflection.x = 0;
    const before = pose.bodyYaw;
    run(20);
    expect(ctrl.getPose().bodyYaw).toBe(before);
  });

  it('never exceeds the body yaw limit', () => {
    const { ctrl, deflection, run } = makeRig();
    deflection.x = 1;
    run(400);
    expect(ctrl.getPose().bodyYaw).toBe(-TELEPRESENCE_LIMITS.bodyYawDeg);
  });

  it('slews slider targets instead of jumping, head world yaw follows the base', () => {
    const { ctrl, calls, run } = makeRig();
    ctrl.setBodyYawTarget(90);
    run(1);
    // 90°/s * 50 ms = 4.5° per tick
    expect(calls.body.at(-1)).toBeCloseTo(4.5);
    run(40);
    expect(calls.body.at(-1)).toBeCloseTo(90);
    expect(calls.head.at(-1)?.[2]).toBeCloseTo(90);
  });

  it('clamps antennas and roll to their limits', () => {
    const { ctrl } = makeRig();
    ctrl.setAntennasTarget(500, -500);
    ctrl.setRollTarget(-100);
    const { targets } = ctrl.getSnapshot();
    expect(targets.antennaRight).toBe(TELEPRESENCE_LIMITS.antennaDeg);
    expect(targets.antennaLeft).toBe(-TELEPRESENCE_LIMITS.antennaDeg);
    expect(targets.roll).toBe(-TELEPRESENCE_LIMITS.rollDeg);
  });

  it('recenterHead glides head back but keeps the base', () => {
    const { ctrl, deflection, run } = makeRig();
    ctrl.setBodyYawTarget(30);
    deflection.x = 0.8;
    deflection.y = 0.8;
    run(10);
    deflection.x = 0;
    deflection.y = 0;
    run(20);
    expect(ctrl.getSnapshot().headOffCenter).toBe(true);
    ctrl.recenterHead();
    run(40);
    expect(ctrl.getSnapshot().headOffCenter).toBe(false);
    expect(ctrl.getPose().bodyYaw).toBe(30);
  });

  it('grabbing the stick cancels a recenter', () => {
    const { ctrl, deflection, run } = makeRig();
    deflection.x = 1;
    run(10);
    deflection.x = 0;
    ctrl.recenterHead();
    run(1);
    deflection.x = 1;
    const before = ctrl.getPose().headYawRel;
    run(2);
    expect(ctrl.getPose().headYawRel).toBeLessThan(before);
  });

  it('deduplicates frames while idle', () => {
    const { ctrl, calls, deflection, run } = makeRig();
    deflection.x = 0.5;
    run(5);
    deflection.x = 0;
    const count = calls.frames;
    run(50);
    expect(calls.frames).toBe(count);
    expect(ctrl.getPose().headYawRel).not.toBe(0);
  });

  it('follows the robot pose until touched, then continues from it', () => {
    const robotPose: ReportedPose = { yaw: 30, bodyYaw: 20, pitch: 5, roll: 0, antennaRight: 10, antennaLeft: -10 };
    const { ctrl, calls, deflection, run } = makeRig({ robotPose });
    run(3);
    expect(calls.frames).toBe(0);
    expect(ctrl.getPose().headYawRel).toBeCloseTo(10);
    expect(ctrl.getSnapshot().targets.bodyYaw).toBe(20);
    deflection.y = -0.3;
    run(1);
    const [, pitch, yaw] = calls.head[0];
    expect(yaw).toBeCloseTo(30); // world yaw unchanged: no snap to 0
    expect(pitch).toBeLessThan(5);
    expect(calls.body[0]).toBeCloseTo(20);
  });

  it('sends nothing and drops ownership while canMove() is false', () => {
    let allowed = true;
    const { ctrl, calls, deflection, run } = makeRig({ canMove: () => allowed });
    deflection.x = 1;
    run(3);
    const count = calls.frames;
    allowed = false;
    run(10);
    ctrl.setBodyYawTarget(50);
    ctrl.recenterHead();
    run(10);
    expect(calls.frames).toBe(count);
  });

  it('a restart during park() keeps the loop running', async () => {
    vi.useFakeTimers();
    try {
      const { ctrl, deflection, run } = makeRig();
      deflection.x = 1;
      run(10);
      deflection.x = 0;
      const parked = ctrl.park();
      ctrl.start();
      await vi.advanceTimersByTimeAsync(3000);
      await parked;
      expect(ctrl.running).toBe(true);
      ctrl.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('park() ignores a stick frozen mid-drag and glides back to neutral', async () => {
    vi.useFakeTimers();
    try {
      const { ctrl, calls, deflection, run } = makeRig();
      ctrl.setBodyYawTarget(40);
      ctrl.setAntennasTarget(30, -30);
      deflection.x = 1; // unmounted joystick left its ref deflected
      run(20);
      const parked = ctrl.park();
      await vi.advanceTimersByTimeAsync(3000);
      await parked;
      expect(ctrl.running).toBe(false);
      expect(calls.body.at(-1)).toBeCloseTo(0);
      expect(calls.head.at(-1)?.[2]).toBeCloseTo(0);
      expect(calls.antennas.at(-1)?.[0]).toBeCloseTo(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
