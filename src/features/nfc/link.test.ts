/**
 * Who writes the accessory: the conversation app while a conversation runs
 * (it plays its write cue and knows the tag is fresh), the daemon otherwise.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { linkAccessory } from './link';
import type { NfcTag } from './nfcState';

function fakeRobot(answer: unknown) {
  const rpcCall =
    answer instanceof Error ? vi.fn().mockRejectedValue(answer) : vi.fn().mockResolvedValue(answer);
  return { robot: { rpcCall } as unknown as ReachyMiniInstance, rpcCall };
}

describe('linkAccessory', () => {
  it('has the conversation app write the tag while a conversation runs', async () => {
    const { robot, rpcCall } = fakeRobot({ written: true });

    await expect(
      linkAccessory(robot, 'noir_detective', null, { conversationLive: true })
    ).resolves.toEqual({ ok: true, written: true });
    expect(rpcCall).toHaveBeenCalledExactlyOnceWith(
      'rfid.link_tag',
      { personality: 'noir_detective' },
      expect.anything()
    );
  });

  it('reports what the conversation app refused', async () => {
    const { robot } = fakeRobot(new Error('No accessory on the reader'));

    await expect(
      linkAccessory(robot, 'noir_detective', null, { conversationLive: true })
    ).resolves.toEqual({ ok: false, error: 'No accessory on the reader' });
  });

  it('writes through the daemon when no conversation runs', async () => {
    const { robot, rpcCall } = fakeRobot({ success: true });

    await expect(
      linkAccessory(robot, 'noir_detective', null, { conversationLive: false })
    ).resolves.toEqual({ ok: true, written: true });
    expect(rpcCall.mock.calls.map(call => call[0])).toEqual(['nfc.write']);
  });

  it('writes nothing to an accessory that already carries the personality', async () => {
    const first = fakeRobot({ success: true });
    await linkAccessory(first.robot, 'noir_detective', null, { conversationLive: false });
    const token = (first.rpcCall.mock.calls[0][1] as { text: string }).text;
    const { robot, rpcCall } = fakeRobot({ success: true });

    await expect(
      linkAccessory(robot, 'noir_detective', { content: token } as NfcTag, {
        conversationLive: false,
      })
    ).resolves.toEqual({ ok: true, written: false });
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it('says the link is lost without a robot, whoever would have written', async () => {
    for (const conversationLive of [true, false]) {
      const outcome = await linkAccessory(null, 'noir_detective', null, { conversationLive });
      expect(outcome.ok).toBe(false);
    }
  });
});
