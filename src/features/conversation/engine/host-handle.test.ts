/**
 * In-place recovery after a fatal transport error.
 *
 * The fatal teardown asks the robot to stop the conversation app, but that
 * request rides the link that just died, so the app usually keeps running.
 * Recovery must follow it again instead of parking the orb on "tap to start".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RobotSession } from '@/features/robot-session/RobotSession';
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { createConversationHandle, type ConversationHandleDeps } from './host-handle';

const convAppRunning = vi.hoisted(() => ({ value: false }));

vi.mock('@/features/robot-session/recovery-target', () => ({
  waitForRecoveryTarget: vi.fn().mockResolvedValue('new-peer'),
}));
vi.mock('@/features/conv-app/app-slot', () => ({
  isConvAppRunning: vi.fn(async () => convAppRunning.value),
}));

function recoveringHandle() {
  const fatals = { count: 0 };
  const session = {
    isEstablished: vi.fn().mockReturnValue(false),
    ensureConnected: vi.fn().mockResolvedValue({ ok: true }),
    getKnownRobots: vi.fn().mockReturnValue([]),
    setSelectedRobotId: vi.fn(),
    reacquire: vi.fn().mockResolvedValue({ ok: true }),
    wakeUp: vi.fn().mockResolvedValue(undefined),
    setEstablished: vi.fn(),
  };
  const deps = {
    getRobot: () => ({ state: 'connected' }) as unknown as ReachyMiniInstance,
    session: session as unknown as RobotSession,
    isUnmounted: () => false,
    setConvoActiveRequested: vi.fn(),
    runConversationParts: vi.fn().mockResolvedValue(undefined),
    setConnectionState: vi.fn(),
    setConversationState: vi.fn(),
    emitConnectionAttempt: vi.fn(),
    onFatalError: vi.fn(async () => {
      fatals.count += 1;
    }),
    getFatalCount: () => fatals.count,
  };
  const handle = createConversationHandle(deps as unknown as ConversationHandleDeps);
  return { handle, deps, session, fatals };
}

describe('recoverSession', () => {
  beforeEach(() => {
    convAppRunning.value = false;
  });

  it('follows the conversation the robot kept running through the outage', async () => {
    convAppRunning.value = true;
    const { handle, deps } = recoveringHandle();

    await handle.recoverSession({ robotId: 'old-peer', robotName: 'reachy' });

    expect(deps.setConnectionState).toHaveBeenLastCalledWith('live');
    await vi.waitFor(() => expect(deps.runConversationParts).toHaveBeenCalledOnce());
    expect(deps.setConvoActiveRequested).toHaveBeenCalledWith(true);
  });

  it('does not hold the recovery on the re-follow', async () => {
    convAppRunning.value = true;
    const { handle, deps } = recoveringHandle();
    // The conversation app's readiness calls can take long on a lossy link.
    deps.runConversationParts.mockImplementation(() => new Promise(() => {}));

    await handle.recoverSession({ robotId: 'old-peer', robotName: 'reachy' });

    expect(deps.setConnectionState).toHaveBeenLastCalledWith('live');
  });

  it('stays on "tap to start" when no conversation is running', async () => {
    const { handle, deps } = recoveringHandle();

    await handle.recoverSession({ robotId: 'old-peer', robotName: 'reachy' });

    expect(deps.setConversationState).toHaveBeenLastCalledWith('idle');
    expect(deps.runConversationParts).not.toHaveBeenCalled();
  });

  it('does not announce live when the session died during the wake-up', async () => {
    convAppRunning.value = true;
    const { handle, deps, session, fatals } = recoveringHandle();
    // The robot ends the fresh session while recovery awaits wakeUp: the
    // unsolicited-drop path raises a fatal (and sets `error`) meanwhile.
    session.wakeUp.mockImplementation(async () => {
      fatals.count += 1;
    });

    await handle.recoverSession({ robotId: 'old-peer', robotName: 'reachy' });

    expect(deps.setConnectionState).not.toHaveBeenCalledWith('live');
    expect(session.setEstablished).not.toHaveBeenCalledWith(true);
    expect(deps.runConversationParts).not.toHaveBeenCalled();
  });

  it('does not re-follow the conversation when the session died meanwhile', async () => {
    const { handle, deps, fatals } = recoveringHandle();
    const appSlot = await import('@/features/conv-app/app-slot');
    vi.mocked(appSlot.isConvAppRunning).mockImplementationOnce(async () => {
      fatals.count += 1;
      return true;
    });

    await handle.recoverSession({ robotId: 'old-peer', robotName: 'reachy' });
    await new Promise((r) => setTimeout(r, 0));

    expect(deps.runConversationParts).not.toHaveBeenCalled();
  });
});
