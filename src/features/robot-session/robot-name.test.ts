import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renameRobot } from './robot-name';

/**
 * Fake robot with the SDK's reply-slot semantics for the name commands
 * (`PendingReplies.slotRoundtrip`): `get_robot_name` and `set_robot_name`
 * share ONE slot, a newer request resolves the pending one to `null`, a
 * late reply goes to whoever holds the slot, and an unanswered request
 * resolves `null` after 4 s. The daemon side answers after `ackDelayMs`
 * (it acks a rename only once its mDNS service is re-registered).
 */
const SLOT_TIMEOUT_MS = 4000;

function fakeRobot({ ackDelayMs = 0, rejectRename = false } = {}) {
  let stored: string | null = null;
  let waiter: ((v: string | null) => void) | null = null;

  const roundtrip = (onDaemon: () => string | null): Promise<string | null> =>
    new Promise((resolve) => {
      waiter?.(null);
      const settle = (v: string | null) => {
        clearTimeout(timer);
        if (waiter === settle) waiter = null;
        resolve(v);
      };
      waiter = settle;
      const timer = setTimeout(() => settle(null), SLOT_TIMEOUT_MS);
      setTimeout(() => {
        const reply = onDaemon();
        waiter?.(reply);
      }, ackDelayMs);
    });

  return {
    getRobotName: vi.fn(() => roundtrip(() => stored)),
    setRobotName: vi.fn((name: string) =>
      roundtrip(() => {
        if (rejectRename) return null;
        stored = name.trim();
        return stored;
      }),
    ),
    stored: () => stored,
  };
}

describe('renameRobot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the acked name without reading it back', async () => {
    const robot = fakeRobot({ ackDelayMs: 50 });
    const result = renameRobot(robot, 'Mino');
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBe('Mino');
    expect(robot.getRobotName).not.toHaveBeenCalled();
  });

  it('the bare SDK call loses a rename superseded by a name read', async () => {
    // What the naming step hit: the daemon takes 2 s to ack, and a name
    // read fired meanwhile takes over the shared slot.
    const robot = fakeRobot({ ackDelayMs: 2000 });
    const raw = robot.setRobotName('Mino');
    await vi.advanceTimersByTimeAsync(500);
    void robot.getRobotName();
    await expect(raw).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(robot.stored()).toBe('Mino');
  });

  it('keeps a rename whose ack was taken by another name request', async () => {
    const robot = fakeRobot({ ackDelayMs: 2000 });
    const result = renameRobot(robot, 'Mino');
    await vi.advanceTimersByTimeAsync(500);
    void robot.getRobotName();
    await vi.advanceTimersByTimeAsync(4000);
    await expect(result).resolves.toBe('Mino');
  });

  it('keeps a rename the daemon acked after the SDK timeout', async () => {
    const robot = fakeRobot({ ackDelayMs: 5000 });
    const result = renameRobot(robot, '  Mino ');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe('Mino');
  });

  it('resolves null when the robot did not take the name', async () => {
    const robot = fakeRobot({ rejectRename: true });
    const result = renameRobot(robot, 'Mino');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBeNull();
    expect(robot.stored()).toBeNull();
  });

  it('propagates a closed data channel', async () => {
    const robot = {
      getRobotName: vi.fn(),
      setRobotName: vi.fn(() => Promise.reject(new Error('Data channel not open'))),
    };
    await expect(renameRobot(robot, 'Mino')).rejects.toThrow('Data channel not open');
    expect(robot.getRobotName).not.toHaveBeenCalled();
  });
});
