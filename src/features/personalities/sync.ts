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
import type { ConvAppClient } from '@/features/conv-app/client';

import {
  cacheCatalog,
  clearPendingWrites,
  getPendingWrites,
  resolvePersonalityById,
} from './store';

export async function syncPersonalitiesToRobot(client: ConvAppClient): Promise<void> {
  cacheCatalog(await client.getPersonalities());

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
        greeting: personality.tagline,
        voice: personality.voice,
      });
      pushed.dirty.push(id);
    } catch (err) {
      console.warn(`[personalities] could not save ${id} on the robot:`, err);
    }
  }

  clearPendingWrites(pushed);
}
