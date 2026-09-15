/**
 * What the phone hands the robot when a conversation starts.
 *
 * The settings panel disables language, scene awareness and memory while a
 * conversation runs, so the user can only change them while the conversation
 * app is stopped and unreachable. These tests pin that the values reach the
 * robot at the next start, and that a start costs nothing when nothing changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setActiveLanguageId } from '@/features/conversation-language';
import { setMemoryEnabled, setVisionEnabled } from '@/features/conversation-settings';

import type { ConvAppClient, ConvAppStatus } from './client';
import {
  cacheFacts,
  consumeClearPending,
  getFacts,
  isClearPending,
  requestClear,
} from './memory-cache';
import { applySettingsToRobot } from './sync-settings';

const FACT = { id: 'm_1', text: 'Has a dog named Mochi', createdAt: 1 };

function fakeClient(facts = [FACT]) {
  return {
    setLanguage: vi.fn().mockResolvedValue('fr'),
    setMemoryEnabled: vi.fn().mockResolvedValue(false),
    setVisionEnabled: vi.fn().mockResolvedValue(false),
    listMemory: vi.fn().mockResolvedValue(facts),
    clearMemory: vi.fn().mockResolvedValue(undefined),
    getPersonalities: vi.fn().mockResolvedValue([]),
    applyPersonality: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConvAppClient & {
    setLanguage: ReturnType<typeof vi.fn>;
    setMemoryEnabled: ReturnType<typeof vi.fn>;
    setVisionEnabled: ReturnType<typeof vi.fn>;
    listMemory: ReturnType<typeof vi.fn>;
    clearMemory: ReturnType<typeof vi.fn>;
    getPersonalities: ReturnType<typeof vi.fn>;
    applyPersonality: ReturnType<typeof vi.fn>;
  };
}

function status(overrides: Partial<ConvAppStatus> = {}): ConvAppStatus {
  return {
    backend_connected: true,
    backend_error: null,
    has_hf_connection: true,
    personality: 'default',
    language: 'en',
    memory_enabled: true,
    vision_enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  cacheFacts([]);
  consumeClearPending();
  setActiveLanguageId('en');
  setMemoryEnabled(true);
  setVisionEnabled(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applySettingsToRobot', () => {
  it('pushes only what the robot disagrees with', async () => {
    setActiveLanguageId('fr');
    setVisionEnabled(false);
    const client = fakeClient();

    await applySettingsToRobot(client, status());

    expect(client.setLanguage).toHaveBeenCalledWith('fr');
    expect(client.setVisionEnabled).toHaveBeenCalledWith(false);
    expect(client.setMemoryEnabled).not.toHaveBeenCalled();
  });

  it('pushes nothing when the robot already agrees', async () => {
    const client = fakeClient();

    await applySettingsToRobot(client, status());

    expect(client.setLanguage).not.toHaveBeenCalled();
    expect(client.setVisionEnabled).not.toHaveBeenCalled();
    expect(client.setMemoryEnabled).not.toHaveBeenCalled();
  });

  it('refreshes the memory cache from the robot', async () => {
    const client = fakeClient();

    await applySettingsToRobot(client, status());

    expect(getFacts()).toEqual([FACT]);
  });

  it('clears the robot when the user asked while it was unreachable', async () => {
    cacheFacts([FACT]);
    requestClear();
    expect(getFacts()).toEqual([]);
    expect(isClearPending()).toBe(true);
    const client = fakeClient([]);

    await applySettingsToRobot(client, status());

    expect(client.clearMemory).toHaveBeenCalled();
    expect(isClearPending()).toBe(false);
  });

  it('starts the conversation even when a setting fails to apply', async () => {
    setActiveLanguageId('fr');
    const client = fakeClient();
    client.setLanguage.mockRejectedValue(new Error('not_running'));

    await expect(applySettingsToRobot(client, status())).resolves.toBeUndefined();
  });
});
