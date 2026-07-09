/** Tests the client maps calls to JSON-RPC methods and propagates rejections. */
import { describe, expect, it, vi } from 'vitest';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { createConvAppClient } from './client';

function robotReturning(result: unknown) {
  const rpcCall = vi.fn().mockResolvedValue(result);
  const onNotification = vi.fn().mockReturnValue(() => {});
  return {
    robot: { rpcCall, onNotification } as unknown as ReachyMiniInstance,
    rpcCall,
    onNotification,
  };
}

describe('createConvAppClient', () => {
  it('unwraps the result of a JSON-RPC method', async () => {
    const { robot, rpcCall } = robotReturning({ muted: true });
    await expect(createConvAppClient(robot).getMicMuted()).resolves.toBe(true);
    expect(rpcCall).toHaveBeenCalledWith('conversation.mic');
  });

  it('propagates a JSON-RPC rejection', async () => {
    const rpcCall = vi.fn().mockRejectedValue(new Error('not_running'));
    const robot = { rpcCall, onNotification: vi.fn() } as unknown as ReachyMiniInstance;
    await expect(createConvAppClient(robot).getStatus()).rejects.toThrow('not_running');
  });

  it('starts the app via apps.start with a longer timeout', async () => {
    const { robot, rpcCall } = robotReturning({});
    await createConvAppClient(robot).startConvApp();
    expect(rpcCall).toHaveBeenCalledWith(
      'apps.start',
      { name: 'reachy_mini_conversation_app' },
      { timeoutMs: 60000 }
    );
  });

  it('applies a personality with persist', async () => {
    const { robot, rpcCall } = robotReturning({ ok: true });
    await createConvAppClient(robot).applyPersonality('sorry_bro');
    expect(rpcCall).toHaveBeenCalledWith('personalities.apply', {
      name: 'sorry_bro',
      persist: true,
    });
  });

  it('installs via apps.install with a long timeout', async () => {
    const { robot, rpcCall } = robotReturning({ installed: true });
    await createConvAppClient(robot).installConvApp();
    expect(rpcCall).toHaveBeenCalledWith(
      'apps.install',
      { name: 'reachy_mini_conversation_app' },
      { timeoutMs: 300_000 }
    );
  });

  it('subscribes to conversation events through onNotification', () => {
    const { robot, onNotification } = robotReturning(null);
    const cb = vi.fn();
    createConvAppClient(robot).on('conversation.turn', cb);
    expect(onNotification).toHaveBeenCalledWith('conversation.turn', cb);
  });
});
