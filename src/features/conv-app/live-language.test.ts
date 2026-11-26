/**
 * Switching language while the robot is talking: a pick reaches the robot
 * at once, a burst of picks ends on the last one, and a failing robot is
 * not hammered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetActiveLanguageId, setActiveLanguageId } from '@/features/conversation-language';

import type { ConvAppClient } from './client';
import { followLanguage } from './live-language';

function fakeClient() {
  return {
    setLanguage: vi.fn().mockImplementation(async (language: string) => language),
  } as unknown as ConvAppClient & { setLanguage: ReturnType<typeof vi.fn> };
}

/** Let the follower's promise chain run to its end. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

let stop: (() => void) | null = null;

beforeEach(() => {
  resetActiveLanguageId();
});

afterEach(() => {
  stop?.();
  stop = null;
  resetActiveLanguageId();
});

describe('followLanguage', () => {
  it('leaves the robot alone until the user picks', async () => {
    const client = fakeClient();
    stop = followLanguage(client, { appliedId: 'auto' });
    await settle();
    expect(client.setLanguage).not.toHaveBeenCalled();
  });

  it('catches up with a pick made while the conversation was starting', async () => {
    const client = fakeClient();
    setActiveLanguageId('fr');
    stop = followLanguage(client, { appliedId: 'auto' });
    await settle();
    expect(client.setLanguage).toHaveBeenCalledTimes(1);
    expect(client.setLanguage).toHaveBeenCalledWith('fr');
  });

  it('applies a pick right away', async () => {
    const client = fakeClient();
    stop = followLanguage(client, { appliedId: 'auto' });
    setActiveLanguageId('fr');
    await settle();
    expect(client.setLanguage).toHaveBeenCalledTimes(1);
    expect(client.setLanguage).toHaveBeenCalledWith('fr');
  });

  it('ends a burst of picks on the last one', async () => {
    const client = fakeClient();
    let release: () => void = () => {};
    client.setLanguage.mockImplementationOnce(
      (language: string) => new Promise(resolve => (release = () => resolve(language)))
    );
    stop = followLanguage(client, { appliedId: 'auto' });
    setActiveLanguageId('fr');
    setActiveLanguageId('de');
    setActiveLanguageId('es');
    release();
    await settle();
    await settle();
    expect(client.setLanguage.mock.calls.map(c => c[0])).toEqual(['fr', 'es']);
  });

  it('does not retry a failing robot on its own', async () => {
    const client = fakeClient();
    client.setLanguage.mockRejectedValue(new Error('loop_unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stop = followLanguage(client, { appliedId: 'auto' });
    setActiveLanguageId('fr');
    await settle();
    await settle();
    expect(client.setLanguage).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('stops following once released', async () => {
    const client = fakeClient();
    stop = followLanguage(client, { appliedId: 'auto' });
    stop();
    stop = null;
    setActiveLanguageId('fr');
    await settle();
    expect(client.setLanguage).not.toHaveBeenCalled();
  });
});
