/**
 * Tests for the SDK placeholder AudioContext reaper.
 *
 * The properties that must hold:
 *   - the context the SDK builds during a dial is closed before the
 *     next dial (explicit restart or auto-reconnect attempt);
 *   - `sessionStopped` closes the current one;
 *   - `window.AudioContext` is restored once the dial returns, so the
 *     app's own contexts are never captured;
 *   - an SDK without the private dial method is left untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReachyMiniInstance } from './sdk-types';

import { installPlaceholderAudioReaper } from './sdk-placeholder-audio';

class FakeAudioContext {
  state: 'running' | 'closed' = 'running';
  close = vi.fn(async () => {
    this.state = 'closed';
  });
}

type FakeSdk = EventTarget & {
  _startSessionInternal: (robotId: string) => Promise<void>;
  built: FakeAudioContext[];
};

function makeSdk(): FakeSdk {
  const sdk = new EventTarget() as FakeSdk;
  sdk.built = [];
  // Mirrors the SDK: the context is built synchronously, before the
  // first await, through whatever `window.AudioContext` is at the time.
  sdk._startSessionInternal = async function (this: FakeSdk) {
    const Ctx = (window as unknown as { AudioContext: typeof FakeAudioContext })
      .AudioContext;
    this.built.push(new Ctx());
    await Promise.resolve();
  };
  return sdk;
}

beforeEach(() => {
  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('installPlaceholderAudioReaper', () => {
  it('closes the previous dial context before the next dial', async () => {
    const sdk = makeSdk();
    installPlaceholderAudioReaper(sdk as unknown as ReachyMiniInstance);

    await sdk._startSessionInternal('robot');
    await sdk._startSessionInternal('robot');

    expect(sdk.built).toHaveLength(2);
    expect(sdk.built[0].close).toHaveBeenCalledOnce();
    expect(sdk.built[1].close).not.toHaveBeenCalled();
  });

  it('closes the current context on sessionStopped', async () => {
    const sdk = makeSdk();
    installPlaceholderAudioReaper(sdk as unknown as ReachyMiniInstance);

    await sdk._startSessionInternal('robot');
    sdk.dispatchEvent(new Event('sessionStopped'));

    expect(sdk.built[0].close).toHaveBeenCalledOnce();
  });

  it('restores window.AudioContext after the dial', async () => {
    const sdk = makeSdk();
    installPlaceholderAudioReaper(sdk as unknown as ReachyMiniInstance);

    await sdk._startSessionInternal('robot');

    expect((window as unknown as { AudioContext: unknown }).AudioContext).toBe(
      FakeAudioContext,
    );
  });

  it('turns itself off on an SDK that closes its own context', async () => {
    const sdk = makeSdk() as FakeSdk & { _micCtx: null };
    sdk._micCtx = null;
    const dial = sdk._startSessionInternal;
    installPlaceholderAudioReaper(sdk as unknown as ReachyMiniInstance);

    expect(sdk._startSessionInternal).toBe(dial);
  });

  it('is a no-op when the SDK has no private dial method', () => {
    const sdk = new EventTarget();
    expect(() =>
      installPlaceholderAudioReaper(sdk as unknown as ReachyMiniInstance),
    ).not.toThrow();
  });
});
