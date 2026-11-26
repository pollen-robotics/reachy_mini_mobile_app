import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  platform: 'android',
  handler: null as null | ((info: { canGoBack: boolean }) => void),
  registered: 0,
  unregistered: 0,
}));

vi.mock('@/shared/platform', () => ({ getPlatform: () => tauri.platform }));
vi.mock('@tauri-apps/api/app', () => ({
  onBackButtonPress: async (handler: (info: { canGoBack: boolean }) => void) => {
    tauri.registered += 1;
    tauri.handler = handler;
    return {
      unregister: async () => {
        tauri.unregistered += 1;
        tauri.handler = null;
      },
    };
  },
}));

import { pushBackHandler } from './androidBack';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const pressBack = (canGoBack = false) => tauri.handler?.({ canGoBack });

beforeEach(() => {
  tauri.platform = 'android';
  tauri.handler = null;
  tauri.registered = 0;
  tauri.unregistered = 0;
});

describe('pushBackHandler', () => {
  it('listens only while something is open', async () => {
    const closeSheet = vi.fn();
    const remove = pushBackHandler(closeSheet);
    await settle();
    expect(tauri.registered).toBe(1);
    pressBack();
    expect(closeSheet).toHaveBeenCalledOnce();
    remove();
    await settle();
    expect(tauri.unregistered).toBe(1);
  });

  it('closes the topmost overlay first', async () => {
    const closeSheet = vi.fn();
    const closeDialog = vi.fn();
    const removeSheet = pushBackHandler(closeSheet);
    const removeDialog = pushBackHandler(closeDialog);
    await settle();
    expect(tauri.registered).toBe(1);
    pressBack();
    expect(closeDialog).toHaveBeenCalledOnce();
    expect(closeSheet).not.toHaveBeenCalled();
    removeDialog();
    pressBack(true);
    expect(closeSheet).toHaveBeenCalledWith({ canGoBack: true });
    removeSheet();
    await settle();
    expect(tauri.unregistered).toBe(1);
  });

  it('does nothing off Android', async () => {
    tauri.platform = 'ios';
    const remove = pushBackHandler(vi.fn());
    await settle();
    expect(tauri.registered).toBe(0);
    remove();
  });
});
