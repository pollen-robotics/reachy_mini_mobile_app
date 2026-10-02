/**
 * Reconcile the phone's personalities with the robot's, at conversation start.
 *
 * The robot owns the catalog, but the personality editor is reachable while the
 * conversation app is stopped and unreachable. So authoring is queued on the
 * phone and pushed here, at the one moment the robot can hear it.
 *
 * The robot's list is read and adopted FIRST, because adopting is what decides
 * what still has to be pushed: an edit made offline, a persona the robot has
 * never seen, a bundled personality this robot does not ship. Then everything
 * outstanding goes over in one pass.
 *
 * A push that fails stays queued rather than being lost: the id is only cleared
 * once the robot has acknowledged it.
 */
import type { ConvAppClient, RobotPersonality } from '@/features/conv-app/client';

import { cacheAvatar, getCachedAvatar } from './avatar-cache';
import { robotAvatarId } from './from-robot';

import {
  cacheCatalog,
  clearPendingWrites,
  getPendingWrites,
  resolvePersonalityById,
} from './store';

export async function syncPersonalitiesToRobot(client: ConvAppClient): Promise<void> {
  const robots = await client.getPersonalities();
  cacheCatalog(robots);

  const pending = getPendingWrites();
  const pushed = { dirty: [] as string[], deleted: [] as string[] };

  for (const id of pending.deleted) {
    try {
      await client.deletePersonality(id);
      pushed.deleted.push(id);
    } catch (err) {
      console.warn(`[personalities] could not delete ${id} on the robot:`, err);
    }
  }

  for (const id of pending.dirty) {
    const personality = resolvePersonalityById(id);
    // Created and deleted between two conversations: nothing to push.
    if (!personality) {
      pushed.dirty.push(id);
      continue;
    }
    try {
      await client.savePersonality({
        name: id,
        instructions: personality.instructions,
        // The robot's greeting is a prompt that drives the opening line; the
        // phone's tagline is a teaser under the avatar. Not the same thing,
        // so the robot keeps its default opening.
        greeting: '',
        voice: personality.voice,
      });
      pushed.dirty.push(id);
    } catch (err) {
      console.warn(`[personalities] could not save ${id} on the robot:`, err);
    }
  }

  clearPendingWrites(pushed);

  // Drawings the robot has and the phone does not; re-adopt so they show.
  if (await fetchMissingAvatars(client, robots)) cacheCatalog(robots);
}

/** Fetch each missing robot drawing once. Resolves true if any landed. */
async function fetchMissingAvatars(
  client: ConvAppClient,
  robots: readonly RobotPersonality[]
): Promise<boolean> {
  let fetched = false;
  const seen = new Set<string>();
  for (const robot of robots) {
    const id = robotAvatarId(robot);
    if (!id || seen.has(id) || getCachedAvatar(id)) continue;
    seen.add(id);
    try {
      cacheAvatar(id, await client.getAvatar(robot.name));
      fetched = true;
    } catch (err) {
      console.warn(`[personalities] could not fetch the avatar of ${robot.name}:`, err);
    }
  }
  return fetched;
}
