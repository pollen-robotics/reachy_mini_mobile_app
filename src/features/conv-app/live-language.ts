/**
 * Keep the robot on the phone's conversation language while a
 * conversation runs.
 *
 * `language.set` takes effect in place: the robot saves it and reconnects
 * its voice backend (not the app), the same way a personality switch does.
 * So a language picked mid-conversation is handed over at once instead of
 * waiting for the next start (`sync-settings.ts` covers that one).
 *
 * Runs are serialised and loop until the robot has caught up, so a burst of
 * taps ends on the last one and the robot reconnects at most once per tap
 * that is still current. A conversation the phone adopted keeps the robot's
 * language until the user picks one.
 */
import {
  getActiveLanguageId,
  subscribeConversationLanguage,
} from '@/features/conversation-language';

import type { ConvAppClient } from './client';

/**
 * Follow the language store until the returned function is called.
 *
 * `appliedId` is the language the robot is known to be on (what the start
 * pushed, or what the phone had when it adopted the conversation). A pick
 * made since then is applied right away.
 */
export function followLanguage(
  client: ConvAppClient,
  { appliedId: startId }: { appliedId: string }
): () => void {
  let appliedId: string = startId;
  let busy = false;
  let stopped = false;

  const catchUp = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      while (!stopped && getActiveLanguageId() !== appliedId) {
        const target = getActiveLanguageId();
        await client.setLanguage(target);
        appliedId = target;
      }
    } catch (err) {
      console.warn('[conv-app] could not switch the language on the robot:', err);
      // Do not spin on a failing robot. The next pick tries again.
      appliedId = getActiveLanguageId();
    } finally {
      busy = false;
    }
  };

  const unsubscribe = subscribeConversationLanguage(() => void catchUp());
  void catchUp();
  return () => {
    stopped = true;
    unsubscribe();
  };
}
