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
    onFatalError: vi.fn(),
  };
  const handle = createConversationHandle(deps as unknown as ConversationHandleDeps);
  return { handle, deps };
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
    expect(deps.setConvoActiveRequested).toHaveBeenCalledWith(true);
    expect(deps.runConversationParts).toHaveBeenCalledOnce();
  });

  it('stays on "tap to start" when no conversation is running', async () => {
    const { handle, deps } = recoveringHandle();

    await handle.recoverSession({ robotId: 'old-peer', robotName: 'reachy' });

    expect(deps.setConversationState).toHaveBeenLastCalledWith('idle');
    expect(deps.runConversationParts).not.toHaveBeenCalled();
  });
});
