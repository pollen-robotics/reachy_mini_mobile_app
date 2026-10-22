/**
 * Apply `followAccessory` to the phone's active personality.
 *
 * `acting` is false while the conversation app runs on the robot: it switches
 * personality on its own then and announces it (`conversation.personality`,
 * followed in `robot-conversation.ts`), so the phone only keeps track.
 *
 * The personality to go back to is kept in the personalities store, so a
 * conversation start can make it the robot's fallback too (`sync-settings.ts`).
 */
import { useEffect, useRef } from 'react';

import { getLiveClient } from '@/features/conv-app/live-client';
import {
  followRobotPersonality,
  getActivePersonalityId,
  getPersonalityBeforeAccessory,
  resolveRobotPersonality,
  setActivePersonality,
  setPersonalityBeforeAccessory,
} from '@/features/personalities';

import type { AccessoryView } from './accessory';
import { IDLE_FOLLOWER, followAccessory, type FollowerState } from './accessory-follower';
import { accessoryPersonalityId } from './useAccessory';

/**
 * After an accessory change mid-conversation, when to check the robot did
 * switch: past the conversation app's own wait (10 s) plus the voice session
 * restart it can run into. A safety net for a lost `conversation.personality`.
 */
const RECONCILE_AFTER_MS = 20_000;

/** Show the personality the robot runs, if the panel shows another one. */
async function reconcileWithRobot(): Promise<void> {
  const client = getLiveClient();
  if (!client) return;
  try {
    const status = await client.getStatus();
    const running = resolveRobotPersonality(status.personality ?? 'default');
    if (running) followRobotPersonality(running.id);
  } catch (err) {
    console.warn('[nfc] could not read the personality the robot runs:', err);
  }
}

export function useAccessoryPersonality(accessory: AccessoryView, acting: boolean): void {
  const previousRef = useRef<AccessoryView | null>(null);
  const stateRef = useRef<FollowerState>({
    ...IDLE_FOLLOWER,
    restoreTo: getPersonalityBeforeAccessory(),
  });
  const { state: accessoryState, personality } = accessory;
  const reconcileRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (reconcileRef.current) clearTimeout(reconcileRef.current);
    },
    []
  );

  useEffect(() => {
    const next: AccessoryView = { state: accessoryState, personality };
    const activeId = getActivePersonalityId();
    const step = followAccessory(
      previousRef.current,
      next,
      stateRef.current,
      accessoryPersonalityId(activeId),
      activeId
    );
    previousRef.current = next;
    stateRef.current = step.state;
    setPersonalityBeforeAccessory(step.state.restoreTo);
    if (!step.action) return;
    if (!acting) {
      // The conversation app switches it and announces it; check it did.
      if (reconcileRef.current) clearTimeout(reconcileRef.current);
      reconcileRef.current = setTimeout(() => void reconcileWithRobot(), RECONCILE_AFTER_MS);
      return;
    }
    if (step.action.kind === 'restore') {
      setActivePersonality(step.action.activeId);
      return;
    }
    const target = resolveRobotPersonality(step.action.personality);
    if (target) setActivePersonality(target.id);
    // `acting` is read, not watched: a conversation starting or stopping is
    // not an accessory coming or going.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessoryState, personality]);
}
