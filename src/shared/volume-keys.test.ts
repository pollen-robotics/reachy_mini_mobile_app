import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clampVolume, subscribeVolumeKeys } from './volume-keys';

describe('clampVolume', () => {
  it('clamps to 0-100 and rounds', () => {
    expect(clampVolume(-5)).toBe(0);
    expect(clampVolume(105)).toBe(100);
    expect(clampVolume(42.6)).toBe(43);
  });
});

describe('subscribeVolumeKeys', () => {
  // Vitest runs in a node environment: stand in a minimal window.
  beforeEach(() => {
    vi.stubGlobal('window', { setInterval, clearInterval });
    vi.stubGlobal('navigator', { userAgent: 'node' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('enables native interception, forwards keys and releases on cleanup', () => {
    const setEnabled = vi.fn();
    window.ReachyNativeVolume = { setEnabled };
    const onKey = vi.fn();
    const off = subscribeVolumeKeys(onKey);
    expect(setEnabled).toHaveBeenLastCalledWith(true);
    window.__reachyVolumeKey?.(1);
    window.__reachyVolumeKey?.(-1);
    window.__reachyVolumeKey?.(7);
    expect(onKey.mock.calls).toEqual([[1], [-1]]);
    off();
    expect(setEnabled).toHaveBeenLastCalledWith(false);
    expect(window.__reachyVolumeKey).toBeUndefined();
  });

  it('keeps the keys for a newer subscriber when an older one cleans up late', () => {
    const setEnabled = vi.fn();
    window.ReachyNativeVolume = { setEnabled };
    const offOld = subscribeVolumeKeys(() => {});
    const onNew = vi.fn();
    subscribeVolumeKeys(onNew);
    offOld();
    expect(setEnabled).toHaveBeenLastCalledWith(true);
    window.__reachyVolumeKey?.(1);
    expect(onNew).toHaveBeenCalledWith(1);
  });

  it('is a no-op without the native bridge', () => {
    const off = subscribeVolumeKeys(() => {});
    expect(() => off()).not.toThrow();
  });
});
