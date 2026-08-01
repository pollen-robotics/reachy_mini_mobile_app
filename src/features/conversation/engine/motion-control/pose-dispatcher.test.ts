/**
 * Tests for the pose dispatcher.
 *
 * The properties that must hold:
 *   - head + antennas staged in the same window flush as ONE combined
 *     `set_full_target`, in wire format (flat matrix, radians);
 *   - a refused or throttled send KEEPS the staged values so the next
 *     flush retries with the freshest state;
 *   - SCTP backpressure (bufferedAmount past threshold) skips the send
 *     and reports through `recordSend`;
 *   - the engine's send gate blocks writes the same way, is reported
 *     under its own label, never touches the throttling flag, and is
 *     reset by `stop()` so a fresh session doesn't inherit it.
 *
 * Flushes are driven manually via `flushNow()` — the periodic timer is
 * just a scheduler around the same function.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { createPoseDispatcher, type PoseDispatcher } from './pose-dispatcher';

// The periodic timer is a Worker-backed interval (browser-only); the
// tests drive flushes manually, so stub the scheduler out entirely.
vi.mock('../../motion/unthrottled-interval', () => ({
  createUnthrottledInterval: vi.fn(() => ({ clear: vi.fn() })),
}));

interface SentCmd {
  type: string;
  head?: number[];
  antennas?: [number, number];
}

let sendRaw: ReturnType<typeof vi.fn>;
let recordSend: ReturnType<typeof vi.fn>;
let bufferedAmount: number;
let robot: unknown;
let dispatcher: PoseDispatcher;

beforeEach(() => {
  sendRaw = vi.fn().mockReturnValue(true);
  recordSend = vi.fn();
  bufferedAmount = 0;
  robot = {
    sendRaw,
    // The dispatcher peeks at the SDK's private `_dc` for backpressure.
    get _dc() {
      return { bufferedAmount } as RTCDataChannel;
    },
  };
  dispatcher = createPoseDispatcher({
    getRobot: () => robot as ReachyMiniInstance | null,
    recordSend,
  });
});

function lastCmd(): SentCmd {
  return sendRaw.mock.calls.at(-1)![0] as SentCmd;
}

describe('coalescing and wire format', () => {
  it('combines head and antennas staged in the same window into one frame', () => {
    dispatcher.setHead(0, 0, 0);
    dispatcher.setAntennas(90, -90);
    dispatcher.flushNow();

    expect(sendRaw).toHaveBeenCalledTimes(1);
    const cmd = lastCmd();
    expect(cmd.type).toBe('set_full_target');
    // Identity rotation for (0,0,0), row-major flat 4×4.
    expect(cmd.head).toHaveLength(16);
    expect(cmd.head![0]).toBeCloseTo(1);
    expect(cmd.head![5]).toBeCloseTo(1);
    expect(cmd.head![10]).toBeCloseTo(1);
    // Degrees converted to radians at flush time.
    expect(cmd.antennas![0]).toBeCloseTo(Math.PI / 2);
    expect(cmd.antennas![1]).toBeCloseTo(-Math.PI / 2);
    expect(recordSend).toHaveBeenCalledWith(true, 'pose-dispatcher');
  });

  it('sends only the axes staged since the previous flush', () => {
    dispatcher.setHead(0, 0, 0);
    dispatcher.flushNow();
    dispatcher.setAntennas(10, 10);
    dispatcher.flushNow();

    expect(sendRaw).toHaveBeenCalledTimes(2);
    const second = lastCmd();
    expect(second.antennas).toBeDefined();
    expect(second.head).toBeUndefined();
  });

  it('does nothing when no update is staged', () => {
    dispatcher.flushNow();
    expect(sendRaw).not.toHaveBeenCalled();
    expect(recordSend).not.toHaveBeenCalled();
  });

  it('does nothing while the robot ref is null', () => {
    robot = null;
    dispatcher.setHead(1, 2, 3);
    dispatcher.flushNow();
    expect(recordSend).not.toHaveBeenCalled();
  });
});

describe('retry on refused sends', () => {
  it('keeps the staged values when the channel refuses the send', () => {
    sendRaw.mockReturnValueOnce(false);
    dispatcher.setAntennas(10, 10);
    dispatcher.flushNow();
    expect(recordSend).toHaveBeenLastCalledWith(false, 'pose-dispatcher');

    // The channel comes back: the retry carries the FRESHEST values.
    dispatcher.setAntennas(20, 20);
    dispatcher.flushNow();
    expect(sendRaw).toHaveBeenCalledTimes(2);
    expect(lastCmd().antennas![0]).toBeCloseTo((20 * Math.PI) / 180);
  });
});

describe('SCTP backpressure', () => {
  it('skips the send past the buffered threshold and keeps the staged values', () => {
    bufferedAmount = 20_000; // above the 16 KB default
    dispatcher.setHead(1, 2, 3);
    dispatcher.flushNow();

    expect(sendRaw).not.toHaveBeenCalled();
    expect(recordSend).toHaveBeenCalledWith(false, 'pose-dispatcher-backpressure');
    expect(dispatcher.isThrottling()).toBe(true);

    // Buffer drains: the same staged values go out and the flag clears.
    bufferedAmount = 0;
    dispatcher.flushNow();
    expect(sendRaw).toHaveBeenCalledTimes(1);
    expect(dispatcher.isThrottling()).toBe(false);
  });
});

describe('engine send gate (transport degradation)', () => {
  it('blocks writes under its own label without touching the throttling flag', () => {
    dispatcher.setSendGate(true);
    expect(dispatcher.isGated()).toBe(true);

    dispatcher.setHead(1, 2, 3);
    dispatcher.flushNow();
    expect(sendRaw).not.toHaveBeenCalled();
    expect(recordSend).toHaveBeenCalledWith(false, 'pose-dispatcher-gated');
    // A deliberate gate is not SCTP backpressure.
    expect(dispatcher.isThrottling()).toBe(false);
  });

  it('resumes with the freshest staged values once ungated', () => {
    dispatcher.setSendGate(true);
    dispatcher.setAntennas(10, 10);
    dispatcher.flushNow();
    dispatcher.setAntennas(30, 30);

    dispatcher.setSendGate(false);
    dispatcher.flushNow();
    expect(sendRaw).toHaveBeenCalledTimes(1);
    expect(lastCmd().antennas![0]).toBeCloseTo((30 * Math.PI) / 180);
  });

  it('stop() resets the gate so a fresh session starts open', () => {
    dispatcher.setSendGate(true);
    dispatcher.start();
    dispatcher.stop();
    expect(dispatcher.isGated()).toBe(false);

    dispatcher.setHead(0, 0, 0);
    dispatcher.flushNow();
    expect(sendRaw).toHaveBeenCalledTimes(1);
  });
});
