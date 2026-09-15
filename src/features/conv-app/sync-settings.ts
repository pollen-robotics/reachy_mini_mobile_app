/**
 * Apply the phone's conversation settings to the robot, at conversation start.
 *
 * Language, scene awareness and long-term memory are chosen in the settings
 * panel, which disables all three while a conversation runs. So the moment the
 * user can change them is exactly the moment the conversation app is stopped
 * and unreachable. Rather than write through on every toggle, the phone keeps
 * the values and pushes them once the app is up: one mechanism, applied where
 * the robot can actually hear it.
 *
 * Each push is skipped when the robot already agrees, so a start costs nothing
 * when nothing changed. Failures are logged and swallowed: a setting that did
 * not take is not a reason to refuse the conversation.
 */
import { getActiveLanguageId } from '@/features/conversation-language';
import { isMemoryEnabled, isVisionEnabled } from '@/features/conversation-settings';

import type { ConvAppClient, ConvAppStatus } from './client';
import { cacheFacts, consumeClearPending, isClearPending } from './memory-cache';

export async function applySettingsToRobot(
  client: ConvAppClient,
  status: ConvAppStatus
): Promise<void> {
  const language = getActiveLanguageId();
  const memory = isMemoryEnabled();
  const vision = isVisionEnabled();

  try {
    if (status.language !== language) await client.setLanguage(language);
    if (status.memory_enabled !== memory) await client.setMemoryEnabled(memory);
    if (status.vision_enabled !== vision) await client.setVisionEnabled(vision);
  } catch (err) {
    console.warn('[conv-app] could not apply settings to the robot:', err);
  }

  try {
    if (isClearPending()) {
      await client.clearMemory();
      consumeClearPending();
    }
    cacheFacts(await client.listMemory());
  } catch (err) {
    console.warn('[conv-app] could not sync memory with the robot:', err);
  }
}
