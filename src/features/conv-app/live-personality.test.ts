/**
 * Switching personality while the robot is talking.
 *
 * The picker stays open during a conversation. These tests pin that a pick
 * reaches the robot at once, that a persona written on the phone is pushed
 * before it is applied, that an edit of the active one is re-applied, and that
 * a failing robot is not hammered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addCustomPersonality,
  getPendingWrites,
  setActivePersonality,
  updateCustomPersonality,
} from '@/features/personalities';
import { cacheCatalog, clearPendingWrites } from '@/features/personalities/store';

import type { ConvAppClient, RobotPersonality } from './client';
import { followPersonality } from './live-personality';

const DEFAULT: RobotPersonality = {
  name: 'default',
  instructions: 'Be helpful.',
  greeting: 'Hi there',
  voice: 'Ethan',
};
const PIRATE: RobotPersonality = {
  name: 'user_personalities/pirate',
  instructions: 'Talk like a pirate.',
  greeting: '',
  voice: 'Ethan',
};

function fakeClient(catalog: RobotPersonality[] = [DEFAULT, PIRATE]) {
  return {
    getPersonalities: vi.fn().mockResolvedValue(catalog),
    savePersonality: vi.fn().mockResolvedValue(undefined),
    deletePersonality: vi.fn().mockResolvedValue(undefined),
    applyPersonality: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConvAppClient & {
    getPersonalities: ReturnType<typeof vi.fn>;
    savePersonality: ReturnType<typeof vi.fn>;
    applyPersonality: ReturnType<typeof vi.fn>;
  };
}

/** Let the follower's promise chain run to its end. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

let stop: (() => void) | null = null;

/** Start following, past the first run that re-checks the start's apply. */
async function follow(client: ReturnType<typeof fakeClient>): Promise<void> {
  stop = followPersonality(client, { confirmStart: true });
  await settle();
  client.applyPersonality.mockClear();
}

beforeEach(() => {
  cacheCatalog([DEFAULT, PIRATE]);
  clearPendingWrites(getPendingWrites());
  setActivePersonality(DEFAULT.name);
});

afterEach(() => {
  stop?.();
  stop = null;
});

describe('followPersonality', () => {
  it('re-applies the active persona once, in case the start could not', async () => {
    // A start-time apply can fail while the app boots (`loop_unavailable`).
    const client = fakeClient();
    stop = followPersonality(client, { confirmStart: true });
    await settle();

    expect(client.applyPersonality).toHaveBeenCalledExactlyOnceWith(DEFAULT.name, {
      force: false,
    });
  });

  it('writes nothing to an adopted conversation until the user picks', async () => {
    const client = fakeClient();
    stop = followPersonality(client, { confirmStart: false });
    await settle();
    expect(client.applyPersonality).not.toHaveBeenCalled();

    setActivePersonality(PIRATE.name);
    await settle();
    expect(client.applyPersonality).toHaveBeenCalledExactlyOnceWith(PIRATE.name, {
      force: false,
    });
  });

  it('applies a pick at once, without a catalog round-trip', async () => {
    const client = fakeClient();
    await follow(client);

    setActivePersonality(PIRATE.name);
    await settle();

    expect(client.applyPersonality).toHaveBeenCalledExactlyOnceWith(PIRATE.name, {
      force: false,
    });
    expect(client.getPersonalities).not.toHaveBeenCalled();
  });

  it('pushes a persona created mid-conversation before applying it', async () => {
    const client = fakeClient();
    await follow(client);

    // "Save & use": the persona is added, then made active.
    const created = addCustomPersonality({ name: 'Guide', instructions: 'Be a guide.' });
    setActivePersonality(created.id);
    await settle();

    expect(client.savePersonality).toHaveBeenCalledWith(
      expect.objectContaining({ name: created.id, instructions: 'Be a guide.' })
    );
    expect(client.applyPersonality).toHaveBeenLastCalledWith(created.id, { force: false });
    expect(client.savePersonality.mock.invocationCallOrder[0]).toBeLessThan(
      client.applyPersonality.mock.invocationCallOrder.at(-1) ?? 0
    );
    expect(getPendingWrites().dirty).toEqual([]);
  });

  it('re-applies the active persona after an edit', async () => {
    setActivePersonality(PIRATE.name);
    const client = fakeClient();
    await follow(client);

    updateCustomPersonality(PIRATE.name, { name: 'Pirate', instructions: 'Arr, louder.' });
    await settle();

    expect(client.savePersonality).toHaveBeenCalledOnce();
    expect(client.applyPersonality).toHaveBeenCalledExactlyOnceWith(PIRATE.name, {
      force: true,
    });
  });

  it('does not retry a failing robot on every store change', async () => {
    const client = fakeClient();
    await follow(client);
    client.applyPersonality.mockRejectedValue(new Error('timeout'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    setActivePersonality(PIRATE.name);
    await settle();
    // An unrelated store change (the robot catalog re-cached) must not re-fire.
    cacheCatalog([DEFAULT, PIRATE]);
    await settle();

    expect(client.applyPersonality).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('stops following once the conversation ends', async () => {
    const client = fakeClient();
    await follow(client);
    stop?.();
    stop = null;

    setActivePersonality(PIRATE.name);
    await settle();

    expect(client.applyPersonality).not.toHaveBeenCalled();
  });
});
