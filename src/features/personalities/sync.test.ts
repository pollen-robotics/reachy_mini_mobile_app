/**
 * What the phone and the robot agree on when a conversation starts.
 *
 * The personality editor is reachable while the conversation app is stopped, so
 * a persona can be created, edited or deleted with no robot to tell. These
 * tests pin that the authoring reaches the robot at the next start, that a
 * failed push stays queued, and that the phone's own drawing survives adopting
 * the robot's catalog.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConvAppClient, RobotPersonality } from '@/features/conv-app/client';

import {
  addCustomPersonality,
  cacheCatalog,
  clearPendingWrites,
  getPendingWrites,
  removeCustomPersonality,
  resolvePersonalityById,
  setCustomPersonalityAvatar,
} from './store';
import { syncPersonalitiesToRobot } from './sync';

const DEFAULT: RobotPersonality = {
  name: 'default',
  instructions: 'Be helpful.',
  greeting: 'Hi there',
  voice: 'Ethan',
};

function robotPersonality(name: string): RobotPersonality {
  return { name, instructions: 'Be a guide.', greeting: 'Follow me', voice: 'Ethan' };
}

function fakeClient(catalog: RobotPersonality[] = [DEFAULT]) {
  return {
    getPersonalities: vi.fn().mockResolvedValue(catalog),
    savePersonality: vi.fn().mockResolvedValue(undefined),
    deletePersonality: vi.fn().mockResolvedValue(undefined),
    getAvatar: vi.fn().mockResolvedValue('<svg id="kitchen"/>'),
  } as unknown as ConvAppClient & {
    getAvatar: ReturnType<typeof vi.fn>;
    getPersonalities: ReturnType<typeof vi.fn>;
    savePersonality: ReturnType<typeof vi.fn>;
    deletePersonality: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  // Burn the one-shot seeding so each case starts from a settled catalog.
  cacheCatalog([DEFAULT]);
  clearPendingWrites(getPendingWrites());
});

describe('syncPersonalitiesToRobot', () => {
  it('pushes a persona authored while the robot was unreachable', async () => {
    const created = addCustomPersonality({ name: 'Guide', instructions: 'Be a guide.' });
    expect(created.id).toBe('user_personalities/guide');

    const client = fakeClient([DEFAULT, robotPersonality(created.id)]);
    await syncPersonalitiesToRobot(client);

    expect(client.savePersonality).toHaveBeenCalledWith(
      expect.objectContaining({ name: created.id, instructions: 'Be a guide.', greeting: '' })
    );
    expect(getPendingWrites().dirty).toEqual([]);
  });

  it('pushes a deletion and keeps the persona gone', async () => {
    const created = addCustomPersonality({ name: 'Guide', instructions: 'Be a guide.' });
    clearPendingWrites(getPendingWrites());
    removeCustomPersonality(created.id);

    // The robot still reports it: the delete had not been pushed yet.
    const client = fakeClient([DEFAULT, robotPersonality(created.id)]);
    await syncPersonalitiesToRobot(client);

    expect(client.deletePersonality).toHaveBeenCalledWith(created.id);
    expect(getPendingWrites().deleted).toEqual([]);
  });

  it('keeps a failed push queued for the next start', async () => {
    const created = addCustomPersonality({ name: 'Guide', instructions: 'Be a guide.' });
    const client = fakeClient();
    client.savePersonality.mockRejectedValue(new Error('robot said no'));

    await syncPersonalitiesToRobot(client);

    expect(getPendingWrites().dirty).toEqual([created.id]);
  });

  it('keeps the look the phone drew when the robot cannot describe it', async () => {
    const created = addCustomPersonality({
      name: 'Guide',
      tagline: 'Knows the way',
      instructions: 'Be a guide.',
    });
    setCustomPersonalityAvatar(created.id, 'data:image/png;base64,AAAA');

    const client = fakeClient([DEFAULT, robotPersonality(created.id)]);
    await syncPersonalitiesToRobot(client);

    const guide = resolvePersonalityById(created.id);
    expect(guide?.avatar).toBe('data:image/png;base64,AAAA');
    expect(guide?.tagline).toBe('Knows the way');
  });

  it('fetches the drawing of a robot profile the phone does not ship, once', async () => {
    const kitchen = { ...robotPersonality('cosmic_kitchen'), avatar_id: 'cosmic-kitchen' };
    // The phone draws this one itself, so it is never fetched.
    const teen = { ...robotPersonality('bored_teenager'), avatar_id: 'bored-teenager' };
    // The robot's default drawing would only replace the phone's own.
    const tedai = { ...robotPersonality('tedai'), avatar_id: 'default' };

    const client = fakeClient([DEFAULT, kitchen, teen, tedai]);
    await syncPersonalitiesToRobot(client);

    expect(client.getAvatar.mock.calls).toEqual([['cosmic_kitchen']]);
    expect(resolvePersonalityById('cosmic_kitchen')?.avatar).toContain('kitchen');

    const later = fakeClient([DEFAULT, kitchen, teen, tedai]);
    await syncPersonalitiesToRobot(later);
    expect(later.getAvatar).not.toHaveBeenCalled();
  });

  it('drops a persona the robot no longer has', async () => {
    const created = addCustomPersonality({ name: 'Guide', instructions: 'Be a guide.' });
    clearPendingWrites(getPendingWrites());

    await syncPersonalitiesToRobot(fakeClient([DEFAULT]));

    expect(resolvePersonalityById(created.id)).toBeNull();
  });
});
