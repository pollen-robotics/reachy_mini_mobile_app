/**
 * Apply `followAccessory` to the phone's active personality.
 *
 * `acting` is false while the conversation app runs on the robot: it switches
 * personality on its own then and announces it (`conversation.personality`,
 * followed in `robot-conversation.ts`), so the phone only keeps track.
 *
 * The personality to go back to is kept in the personalities store, so a
 * conversation start can make it the robot's default too (`sync-settings.ts`).
 */
import { useEffect, useRef } from 'react';

import { createConvAppClient } from '@/features/conv-app/client';
import {
  followRobotPersonality,
  getActivePersonalityId,
  getPersonalityBeforeAccessory,
  resolveRobotPersonality,
  setActivePersonalityForAccessory,
  setPersonalityBeforeAccessory,
  toRobotPersonalityName,
} from '@/features/personalities';
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import type { AccessoryView } from './accessory';
import { IDLE_FOLLOWER, followAccessory, type FollowerState } from './accessory-follower';

/**
 * After an accessory change mid-conversation, when to check the robot did
 * switch: past the conversation app's own wait (10 s) plus the voice session
 * restart it can run into. A safety net for a lost `conversation.personality`.
 */
const RECONCILE_AFTER_MS = 20_000;

/** Show the personality the robot runs, if the panel shows another one. */
async function reconcileWithRobot(robot: ReachyMiniInstance | null): Promise<void> {
  if (!robot) return;
  try {
    const status = await createConvAppClient(robot).getStatus();
    const running = resolveRobotPersonality(status.personality ?? 'default');
    if (running) followRobotPersonality(running.id);
  } catch (err) {
    console.warn('[nfc] could not read the personality the robot runs:', err);
  }
}

function idOf(name: string | null): string | null {
  return name === null ? null : (resolveRobotPersonality(name)?.id ?? null);
}

export function useAccessoryPersonality(
  accessory: AccessoryView,
  acting: boolean,
  getRobot: () => ReachyMiniInstance | null
): void {
  const previousRef = useRef<AccessoryView | null>(null);
  const stateRef = useRef<FollowerState>(IDLE_FOLLOWER);
  const { state: accessoryState, personality } = accessory;
  const reconcileRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (reconcileRef.current) clearTimeout(reconcileRef.current);
    },
    []
  );
  // The conversation is over: there is no switch left to check.
  useEffect(() => {
    if (!acting || !reconcileRef.current) return;
    clearTimeout(reconcileRef.current);
    reconcileRef.current = null;
  }, [acting]);

  useEffect(() => {
    const next: AccessoryView = { state: accessoryState, personality };
    const fallbackId = getPersonalityBeforeAccessory();
    const step = followAccessory(previousRef.current, next, stateRef.current, {
      active: toRobotPersonalityName(getActivePersonalityId()),
      fallback: fallbackId === null ? null : toRobotPersonalityName(fallbackId),
    });
    previousRef.current = accessoryState === 'unavailable' ? null : next;
    stateRef.current = step.state;
    setPersonalityBeforeAccessory(idOf(step.fallback));
    if (step.switchTo === null) return;
    if (!acting) {
      // The conversation app switches it and announces it; check it did.
      if (reconcileRef.current) clearTimeout(reconcileRef.current);
      reconcileRef.current = setTimeout(
        () => void reconcileWithRobot(getRobot()),
        RECONCILE_AFTER_MS
      );
      return;
    }
    const target = idOf(step.switchTo);
    if (target) setActivePersonalityForAccessory(target);
    // `acting` and `getRobot` are read, not watched: a conversation starting
    // or stopping is not an accessory coming or going.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessoryState, personality]);
}
