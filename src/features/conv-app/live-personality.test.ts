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
  getActivePersonalityId,
  getPendingWrites,
  removeCustomPersonality,
  setActivePersonality,
  setActivePersonalityForAccessory,
  setPersonalityBeforeAccessory,
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
  let onSwitch: ((params: Record<string, unknown>) => void) | null = null;
  return {
    getPersonalities: vi.fn().mockResolvedValue(catalog),
    savePersonality: vi.fn().mockResolvedValue(undefined),
    deletePersonality: vi.fn().mockResolvedValue(undefined),
    applyPersonality: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (params: Record<string, unknown>) => void) => {
      if (event === 'conversation.personality') onSwitch = handler;
      return () => {
        onSwitch = null;
      };
    }),
    /** The robot's `conversation.personality`, sent on every switch it makes. */
    announce: (profile: string) => onSwitch?.({ profile }),
  } as unknown as ConvAppClient & {
    getPersonalities: ReturnType<typeof vi.fn>;
    savePersonality: ReturnType<typeof vi.fn>;
    deletePersonality: ReturnType<typeof vi.fn>;
    applyPersonality: ReturnType<typeof vi.fn>;
    announce: (profile: string) => void;
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
  setPersonalityBeforeAccessory(null);
});

describe('followPersonality', () => {
  it('re-applies the active persona once, in case the start could not', async () => {
    // A start-time apply can fail while the app boots (`loop_unavailable`).
    const client = fakeClient();
    stop = followPersonality(client, { confirmStart: true });
    await settle();

    expect(client.applyPersonality).toHaveBeenCalledExactlyOnceWith(DEFAULT.name, {
      persist: true,
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
      persist: true,
      force: false,
    });
  });

  it('applies a pick at once, without a catalog round-trip', async () => {
    const client = fakeClient();
    await follow(client);

    setActivePersonality(PIRATE.name);
    await settle();

    expect(client.applyPersonality).toHaveBeenCalledExactlyOnceWith(PIRATE.name, {
      persist: true,
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
    expect(client.applyPersonality).toHaveBeenLastCalledWith(created.id, {
      persist: true,
      force: false,
    });
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
      persist: true,
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

describe('followPersonality, when the robot announces a switch', () => {
  it('shows a personality an accessory switched on the robot, without sending it back', async () => {
    const client = fakeClient();
    await follow(client);

    client.announce(PIRATE.name);
    await settle();
    expect(getActivePersonalityId()).toBe(PIRATE.name);
    expect(client.applyPersonality).not.toHaveBeenCalled();

    // The robot is on the pirate now, so going back by hand is a real switch.
    setActivePersonality(DEFAULT.name);
    await settle();
    expect(client.applyPersonality).toHaveBeenCalledExactlyOnceWith(DEFAULT.name, {
      persist: true,
      force: false,
    });
  });

  it('keeps the last of two quick picks when the first one is announced back', async () => {
    const GUIDE: RobotPersonality = { ...PIRATE, name: 'user_personalities/guide' };
    cacheCatalog([DEFAULT, PIRATE, GUIDE]);
    const client = fakeClient();
    await follow(client);
    let answerFirst = (): void => {};
    client.applyPersonality.mockImplementationOnce(
      () => new Promise<void>(resolve => (answerFirst = resolve))
    );

    setActivePersonality(PIRATE.name);
    await settle();
    setActivePersonality(GUIDE.name);
    // The robot announces a switch before it answers the call asking for it.
    client.announce(PIRATE.name);
    answerFirst();
    await settle();

    expect(getActivePersonalityId()).toBe(GUIDE.name);
    expect(client.applyPersonality).toHaveBeenLastCalledWith(GUIDE.name, {
      persist: true,
      force: false,
    });
  });

  it('applies the fallback when the personality an accessory switched to is deleted', async () => {
    const client = fakeClient();
    await follow(client);
    client.announce(PIRATE.name);
    await settle();

    removeCustomPersonality(PIRATE.name);
    await settle();

    expect(client.deletePersonality).toHaveBeenCalledWith(PIRATE.name);
    expect(client.applyPersonality).toHaveBeenCalledExactlyOnceWith(DEFAULT.name, {
      persist: true,
      force: false,
    });
  });

  it('still confirms a start after an accessory switched an earlier conversation', async () => {
    const earlier = fakeClient();
    await follow(earlier);
    earlier.announce(PIRATE.name);
    await settle();
    stop?.();

    const client = fakeClient();
    stop = followPersonality(client, { confirmStart: true });
    await settle();

    expect(client.applyPersonality).toHaveBeenCalledExactlyOnceWith(PIRATE.name, {
      persist: true,
      force: false,
    });
  });

  it('stops listening once the conversation ends', async () => {
    const client = fakeClient();
    await follow(client);
    stop?.();
    stop = null;

    client.announce(PIRATE.name);

    expect(getActivePersonalityId()).toBe(DEFAULT.name);
  });
});

describe('followPersonality, with an NFC accessory on', () => {
  it("runs an accessory's personality without making it the robot's default", async () => {
    setActivePersonalityForAccessory(PIRATE.name);
    setPersonalityBeforeAccessory(DEFAULT.name);
    const client = fakeClient();

    stop = followPersonality(client, { confirmStart: true });
    await settle();

    expect(client.applyPersonality).toHaveBeenCalledExactlyOnceWith(PIRATE.name, {
      persist: false,
      force: false,
    });
  });
});
