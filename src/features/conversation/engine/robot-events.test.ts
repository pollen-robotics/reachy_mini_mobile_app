/**
 * The SDK's `disconnected` event (signaling dropped while no session
 * streams) only demotes connection states it owns.
 *
 * It used to set `authenticated` from any state. Right after a fatal the
 * SDK emits `disconnected` too (when signaling is down), so the `error`
 * state, its caption and the in-place recovery loop that runs off it were
 * wiped: the user was left on a dead orb with nothing retrying.
 */
import { describe, expect, it, vi } from 'vitest';

import type { RobotSession } from '@/features/robot-session/RobotSession';
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { wireRobotEvents, type WireRobotEventsDeps } from './robot-events';
import type { ConnectionState } from './types';

function wired(current: ConnectionState) {
  const robot = Object.assign(new EventTarget(), { isAuthenticated: true });
  const setConnectionState = vi.fn();
  const deps = {
    robot: robot as unknown as ReachyMiniInstance,
    session: { videoCache: { clear: vi.fn() }, guard: {} } as unknown as RobotSession,
    isUnmounted: () => false,
    renderRobotList: vi.fn(),
    applyMicMuted: vi.fn(),
    setConnectionState,
    getConnectionState: () => current,
    onFatalError: vi.fn(),
    isConversationActive: () => false,
    probeRobotLink: vi.fn(),
    onTransportDegraded: vi.fn(),
    onTransportRecovered: vi.fn(),
    onSessionReconnecting: vi.fn(),
    onSessionReconnected: vi.fn(),
  } satisfies WireRobotEventsDeps;
  wireRobotEvents(deps);
  return { robot, setConnectionState };
}

describe('disconnected', () => {
  it.each(['error', 'released', 'starting'] as const)('leaves %s alone', (state) => {
    const { robot, setConnectionState } = wired(state);
    robot.dispatchEvent(new CustomEvent('disconnected', { detail: { reason: 'SSE closed' } }));
    expect(setConnectionState).not.toHaveBeenCalled();
  });

  it.each(['connected', 'selecting', 'live'] as const)('demotes %s to authenticated', (state) => {
    const { robot, setConnectionState } = wired(state);
    robot.dispatchEvent(new CustomEvent('disconnected', { detail: { reason: 'SSE closed' } }));
    expect(setConnectionState).toHaveBeenCalledWith('authenticated');
  });
});
