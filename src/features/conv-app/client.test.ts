/**
 * The conversation-app client's wire contract.
 *
 * These tests pin the method names, payload shapes and timeouts the robot
 * expects. Getting one wrong fails at runtime on a real robot only, so the
 * mapping is worth pinning here rather than discovering on device.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { CONV_APP_NAME, createConvAppClient } from './client';

function robotReturning(result: unknown) {
  const rpcCall = vi.fn().mockResolvedValue(result);
  const onNotification = vi.fn().mockReturnValue(() => {});
  return {
    client: createConvAppClient({ rpcCall, onNotification } as unknown as ReachyMiniInstance),
    rpcCall,
    onNotification,
  };
}

describe('app lifecycle', () => {
  it('starts the conversation app by name, allowing for a cold start', async () => {
    const { client, rpcCall } = robotReturning({});
    await client.startConvApp();
    expect(rpcCall).toHaveBeenCalledWith(
      'apps.start',
      { name: CONV_APP_NAME },
      { timeoutMs: 60_000 }
    );
  });

  it('installs with a timeout long enough for a first Hub download', async () => {
    const { client, rpcCall } = robotReturning({ installed: true });
    await client.installConvApp();
    expect(rpcCall).toHaveBeenCalledWith(
      'apps.install',
      { name: CONV_APP_NAME },
      { timeoutMs: 300_000 }
    );
  });

  it('stops whatever app holds the robot, without naming one', async () => {
    const { client, rpcCall } = robotReturning({ stopped: true });
    await client.stopRunningApp();
    expect(rpcCall).toHaveBeenCalledWith('apps.stop', {}, { timeoutMs: 15_000 });
  });
});

describe('conversation control', () => {
  it('sends the new mic state and returns what the robot confirmed', async () => {
    const { client, rpcCall } = robotReturning({ muted: false });
    await expect(client.setMicMuted(false)).resolves.toBe(false);
    expect(rpcCall).toHaveBeenCalledWith('conversation.mic', { muted: false });
  });

  it('propagates a JSON-RPC rejection with its reason', async () => {
    const error = Object.assign(new Error('no app is running'), { reason: 'not_running' });
    const rpcCall = vi.fn().mockRejectedValue(error);
    const client = createConvAppClient({
      rpcCall,
      onNotification: vi.fn(),
    } as unknown as ReachyMiniInstance);
    await expect(client.getStatus()).rejects.toMatchObject({ reason: 'not_running' });
  });

  it('subscribes to notifications through the SDK', () => {
    const { client, onNotification } = robotReturning(null);
    const handler = vi.fn();
    client.on('conversation.turn', handler);
    expect(onNotification).toHaveBeenCalledWith('conversation.turn', handler);
  });
});
