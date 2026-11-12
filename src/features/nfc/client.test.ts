import { describe, expect, it, vi } from 'vitest';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { createNfcClient } from './client';

function refusingRobot(reason?: string): ReachyMiniInstance {
  const err = Object.assign(new Error('The daemon says no, in words that may change'), { reason });
  return { rpcCall: vi.fn().mockRejectedValue(err) } as unknown as ReachyMiniInstance;
}

describe('createNfcClient tag operations', () => {
  it('passes the daemon result through', async () => {
    const robot = {
      rpcCall: vi.fn().mockResolvedValue({ success: false, error: 'LOCKED' }),
    } as unknown as ReachyMiniInstance;
    await expect(createNfcClient(robot).write({ text: 'hi' })).resolves.toEqual({
      success: false,
      error: 'LOCKED',
    });
  });

  it('reads a refusal while the reader is off as DISABLED', async () => {
    await expect(createNfcClient(refusingRobot('nfc_disabled')).erase(false)).resolves.toEqual({
      success: false,
      error: 'DISABLED',
    });
  });

  it("names any other refusal by its reason, never by the daemon's wording", async () => {
    const client = createNfcClient(refusingRobot('invalid_params'));
    await expect(client.write({ text: 'hi' })).resolves.toEqual({
      success: false,
      error: 'NFC write request failed (invalid_params)',
    });
    await expect(client.erase(true)).resolves.toEqual({
      success: false,
      error: 'NFC full erase request failed (invalid_params)',
    });
  });

  it('reads a call that got no answer as a lost link', async () => {
    await expect(createNfcClient(refusingRobot()).write({ uri: 'https://x.io' })).resolves.toEqual({
      success: false,
      error: 'LINK_LOST',
    });
  });
});
