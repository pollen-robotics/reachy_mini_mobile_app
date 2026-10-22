/**
 * Link the accessory on the reader to a personality: the badge's "Link
 * personality" button.
 *
 * While a conversation runs, the conversation app does it (`rfid.link_tag`),
 * as on desktop, so it also plays its write cue and knows the tag is fresh.
 * Otherwise the app is not running, and the phone writes the same token
 * through the daemon itself.
 */
import { getLiveClient } from '@/features/conv-app/live-client';
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { toTagToken } from './accessory';
import { createNfcClient } from './client';
import { describeTagError, type NfcTag } from './nfcState';

export type LinkOutcome = { ok: true; written: boolean } | { ok: false; error: string };

export async function linkAccessory(
  robot: ReachyMiniInstance | null,
  personality: string,
  tag: NfcTag | null
): Promise<LinkOutcome> {
  const token = toTagToken(personality);
  if (!token) return { ok: false, error: 'This personality cannot be written to an accessory.' };

  const live = getLiveClient();
  if (live) {
    try {
      return { ok: true, ...(await live.linkAccessory(personality)) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (!robot) return { ok: false, error: describeTagError('LINK_LOST') };
  if (tag?.content === token) return { ok: true, written: false };
  const result = await createNfcClient(robot).write({ text: token });
  return result.success
    ? { ok: true, written: true }
    : { ok: false, error: describeTagError(result.error) };
}
