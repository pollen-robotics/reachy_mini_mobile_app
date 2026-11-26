/**
 * Android Back key for the app's own overlays.
 *
 * With no listener, Tauri gives Back to the activity, which closes the app:
 * Back over an open sheet or dialog quit the app instead of closing it.
 * Tauri hands Back to the page only while a listener is registered, so one
 * is held exactly while some overlay is open, and Back closes the topmost
 * one. With nothing open the listener is dropped and Back keeps its default.
 *
 * A no-op off Android.
 */
import { onBackButtonPress, type OnBackButtonPressPayload } from '@tauri-apps/api/app';
import type { PluginListener } from '@tauri-apps/api/core';

import { getPlatform } from '@/shared/platform';

/** Close handlers of the open overlays, the last one on top. */
export type BackHandler = (info: OnBackButtonPressPayload) => void;

const stack: BackHandler[] = [];
let listener: Promise<PluginListener | null> | null = null;

function sync(): void {
  if (stack.length > 0 && listener === null) {
    listener = onBackButtonPress(info => stack[stack.length - 1]?.(info)).catch((err: unknown) => {
      console.warn('[android-back] could not listen to the Back key:', err);
      return null;
    });
  } else if (stack.length === 0 && listener !== null) {
    const held = listener;
    listener = null;
    void held.then(handle => handle?.unregister());
  }
}

/**
 * Make Back call `onBack` until the returned function is called. The most
 * recent registration wins, so a dialog opened over a sheet closes first.
 * `canGoBack` tells an overlay hosting its own navigation (an iframe app)
 * whether there is a page to go back to.
 */
export function pushBackHandler(onBack: BackHandler): () => void {
  if (getPlatform() !== 'android') return () => {};
  const entry: BackHandler = info => onBack(info);
  stack.push(entry);
  sync();
  return () => {
    const index = stack.lastIndexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    sync();
  };
}
