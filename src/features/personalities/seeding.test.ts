/**
 * What happens to the personalities the phone used to own.
 *
 * The phone shipped sixteen personalities and let the user write more. The
 * robot ships fourteen, and five of the phone's have no profile there at all,
 * so adopting the robot's catalog would quietly delete them. They are offered
 * to the robot once instead.
 *
 * Its own file because the offer is one-shot per install, and vitest gives
 * each test file a fresh module.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ConvAppClient, RobotPersonality } from '@/features/conv-app/client';

import { getActivePersonalityId, setActivePersonality } from './store';
import { syncPersonalitiesToRobot } from './sync';

const DEFAULT: RobotPersonality = {
  name: 'default',
  instructions: 'Be helpful.',
  greeting: 'Hi there',
  voice: 'Ethan',
};

function fakeClient(catalog: RobotPersonality[]) {
  return {
    getPersonalities: vi.fn().mockResolvedValue(catalog),
    savePersonality: vi.fn().mockResolvedValue(undefined),
    deletePersonality: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConvAppClient & {
    getPersonalities: ReturnType<typeof vi.fn>;
    savePersonality: ReturnType<typeof vi.fn>;
    deletePersonality: ReturnType<typeof vi.fn>;
  };
}

function savedNames(client: ReturnType<typeof fakeClient>): string[] {
  return client.savePersonality.mock.calls.map(([personality]) => personality.name as string);
}

describe('the bundled personalities a robot does not have', () => {
  it('are offered to it once, without moving the selection', async () => {
    setActivePersonality('builtin:zen_guide');

    const client = fakeClient([DEFAULT]);
    await syncPersonalitiesToRobot(client);

    const saved = savedNames(client);
    expect(saved).toContain('user_personalities/zen_guide');
    expect(saved).toContain('user_personalities/bedtime_storyteller');
    // The robot already has this one, under its own name.
    expect(saved).not.toContain('user_personalities/default');
    // The personality the user was talking to, under the name the robot
    // will know it by.
    expect(getActivePersonalityId()).toBe('user_personalities/zen_guide');

    // Second start: the robot has been offered them, so deleting one there
    // has to keep it deleted.
    const later = fakeClient([DEFAULT]);
    await syncPersonalitiesToRobot(later);
    expect(savedNames(later)).toEqual([]);
  });
});
