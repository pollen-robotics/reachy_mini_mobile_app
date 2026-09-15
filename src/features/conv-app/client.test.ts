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
  it('unwraps the mic state', async () => {
    const { client, rpcCall } = robotReturning({ muted: true });
    await expect(client.getMicMuted()).resolves.toBe(true);
    expect(rpcCall).toHaveBeenCalledWith('conversation.mic');
  });

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

describe('personalities', () => {
  it('reads the full catalog, not just the names', async () => {
    const { client, rpcCall } = robotReturning({
      personalities: [],
      current: 'default',
      startup: 'default',
    });
    await client.getPersonalities();
    expect(rpcCall).toHaveBeenCalledWith('personalities.all');
  });

  it('applies and persists by default, so the choice survives a restart', async () => {
    const { client, rpcCall } = robotReturning({ ok: true });
    await client.applyPersonality('user_personalities/guide');
    expect(rpcCall).toHaveBeenCalledWith('personalities.apply', {
      name: 'user_personalities/guide',
      persist: true,
    });
  });

  it('returns the canonical name the robot saved under', async () => {
    const { client } = robotReturning({ ok: true, value: 'user_personalities/guide' });
    await expect(
      client.savePersonality({ name: 'guide', instructions: 'Be a concise guide.' })
    ).resolves.toBe('user_personalities/guide');
  });
});

describe('settings', () => {
  it('lists memory with the cap and the enabled flag', async () => {
    const { client, rpcCall } = robotReturning({ facts: [], max_facts: 60, enabled: true });
    await expect(client.listMemory()).resolves.toEqual({ facts: [], max_facts: 60, enabled: true });
    expect(rpcCall).toHaveBeenCalledWith('memory.list');
  });

  it('forgets one fact by id and reports what went', async () => {
    const removed = { id: 'm_1', text: 'Has a dog named Mochi', createdAt: 1 };
    const { client, rpcCall } = robotReturning({ ok: true, removed });
    await expect(client.forgetMemory({ id: 'm_1' })).resolves.toEqual(removed);
    expect(rpcCall).toHaveBeenCalledWith('memory.forget', { id: 'm_1' });
  });

  it('returns the state the robot confirmed for each switch', async () => {
    const { client: memory } = robotReturning({ enabled: false });
    await expect(memory.setMemoryEnabled(false)).resolves.toBe(false);

    const { client: vision, rpcCall } = robotReturning({ enabled: false });
    await expect(vision.setVisionEnabled(false)).resolves.toBe(false);
    expect(rpcCall).toHaveBeenCalledWith('vision.set', { enabled: false });
  });

  it('round-trips the transcription language', async () => {
    const { client, rpcCall } = robotReturning({ language: 'fr' });
    await expect(client.setLanguage('fr')).resolves.toBe('fr');
    expect(rpcCall).toHaveBeenCalledWith('language.set', { language: 'fr' });
  });
});
