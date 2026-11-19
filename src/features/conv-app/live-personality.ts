/**
 * Keep the robot on the phone's personality while a conversation runs.
 *
 * The picker stays reachable during a conversation, so the user can pick,
 * create, edit or delete a persona while the robot is talking.
 * `personalities.apply` takes effect in place: the robot rebuilds its voice
 * backend (not the app) and greets as the new persona. Picking alone is not
 * enough, though: a persona written on the phone exists on the robot only once
 * it has been pushed, so every change goes through the same reconcile as a
 * conversation start, then the apply.
 *
 *   picked another persona        → apply it
 *   edited the active one         → push it, apply again (`force`: same name)
 *   created one with "Save & use" → push it, apply it
 *   deleted the active one        → push the delete, apply the fallback
 *
 * The other way round, an accessory on the robot's NFC reader switches the
 * personality there and the phone follows (`conversation.personality`, in
 * `robot-conversation.ts`). That change is the robot's own: it is noted as
 * applied, not sent back.
 *
 * Runs are serialised and loop until the robot has caught up, so a burst of
 * taps ends on the last one. A push that keeps failing is not retried on every
 * store change: only new authoring re-arms it.
 */
import {
  getActivePersonalityId,
  getPendingWrites,
  getPersonalityBeforeAccessory,
  reconcilePersonalities,
  subscribePersonalities,
  wasActivePersonalitySetByRobot,
} from '@/features/personalities';

import type { ConvAppClient } from './client';

/**
 * Follow the personality store until the returned function is called.
 *
 * `confirmStart` is for a conversation the phone started: the start applied
 * the active persona already, but that call can fail while the app is still
 * booting (`loop_unavailable`), so it is applied once more right away. The
 * robot answers "unchanged" without touching the backend when it agrees. An
 * adopted conversation is left as the robot runs it until the user picks.
 */
export function followPersonality(
  client: ConvAppClient,
  { confirmStart }: { confirmStart: boolean }
): () => void {
  let appliedId: string | null = confirmStart ? null : getActivePersonalityId();
  let settledPending = getPendingWrites();
  let busy = false;
  let stopped = false;

  const behind = (): boolean => {
    const pending = getPendingWrites();
    const unpushed =
      pending !== settledPending && pending.dirty.length + pending.deleted.length > 0;
    return getActivePersonalityId() !== appliedId || unpushed;
  };

  const catchUp = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      while (!stopped && behind()) {
        const target = getActivePersonalityId();
        // An accessory switched it on the robot, which is already running it.
        // Not on the run that confirms a start (`appliedId` still null): the
        // flag may date from an earlier conversation.
        if (appliedId !== null && target !== appliedId && wasActivePersonalitySetByRobot()) {
          appliedId = target;
          continue;
        }
        const pending = getPendingWrites();
        const edited = pending.dirty.includes(target);
        // A plain pick of a persona the robot already has needs no catalog
        // round-trip.
        if (pending.dirty.length + pending.deleted.length > 0) {
          await reconcilePersonalities(client);
        }
        // Read before any await: the store cannot change in between, so this
        // is exactly what that reconcile left behind.
        settledPending = getPendingWrites();
        const pushed = edited && !settledPending.dirty.includes(target);
        if (stopped) return;
        if (target !== appliedId || pushed) {
          // Under an accessory the robot's default stays the personality from
          // before it (see `sync-settings.ts`): run this one without saving it.
          await client.applyPersonality(target, {
            persist: getPersonalityBeforeAccessory() === null,
            force: pushed,
          });
        }
        appliedId = target;
      }
    } catch (err) {
      console.warn('[conv-app] could not switch the personality on the robot:', err);
      // Do not spin on a failing robot. The next pick or edit tries again.
      appliedId = getActivePersonalityId();
      settledPending = getPendingWrites();
    } finally {
      busy = false;
    }
  };

  const unsubscribe = subscribePersonalities(() => void catchUp());
  if (confirmStart) void catchUp();
  return () => {
    stopped = true;
    unsubscribe();
  };
}
