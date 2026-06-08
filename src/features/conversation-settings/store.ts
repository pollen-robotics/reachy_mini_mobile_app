/**
 * Conversation-settings runtime store.
 *
 * Tiny pub/sub that mirrors the `conversation-language` store - both
 * are read by the same two worlds:
 *
 *   - the conversation engine (outside the React tree, queried lazily
 *     on every (re)connect via `isVisionEnabled()` / `isMemoryEnabled()`),
 *   - the UI (`useVisionEnabled()` / `useMemoryEnabled()` hooks for the
 *     settings panel toggles).
 *
 * Two independent booleans:
 *   - `visionEnabled`: gates the on-demand `look` tool and its
 *     system-prompt appendix (when off, the model never gets `look`).
 *   - `memoryEnabled`: gates the long-term memory prompt digest and
 *     the `remember` / `forget` tools handed to the model.
 *
 * Both default ON so a fresh install keeps today's behaviour. Because
 * the conversation-settings cog is disabled while a conversation is
 * live, the engine only ever reads these at the next conversation
 * start - no live restart wiring is needed.
 */
import { useSyncExternalStore } from 'react';

import type { RealtimeBackendKind } from '@/features/conversation/engine/realtime/types';

import {
  readMemoryEnabled,
  readRealtimeBackend,
  readVisionEnabled,
  writeMemoryEnabled,
  writeRealtimeBackend,
  writeVisionEnabled,
} from './storage';

type Listener = () => void;

let visionEnabled = readVisionEnabled();
let memoryEnabled = readMemoryEnabled();
let realtimeBackend = readRealtimeBackend();
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (err) {
      console.warn('[conversation-settings] listener threw:', err);
    }
  }
}

/** Subscribe to any conversation-setting change. Returns an
 *  unsubscribe callback. Used by the `useSyncExternalStore` adapters. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ─── Engine-side getters (read lazily at connect time) ───────────── */

export function isVisionEnabled(): boolean {
  return visionEnabled;
}

export function isMemoryEnabled(): boolean {
  return memoryEnabled;
}

/** The realtime provider the next conversation will connect through.
 *  Read lazily by the engine at each (re)connect. */
export function getRealtimeBackend(): RealtimeBackendKind {
  return realtimeBackend;
}

/* ─── Mutations (persist + notify in the same tick) ───────────────── */

export function setVisionEnabled(value: boolean): void {
  if (value === visionEnabled) return;
  visionEnabled = value;
  writeVisionEnabled(value);
  emit();
}

export function setMemoryEnabled(value: boolean): void {
  if (value === memoryEnabled) return;
  memoryEnabled = value;
  writeMemoryEnabled(value);
  emit();
}

export function setRealtimeBackend(value: RealtimeBackendKind): void {
  if (value === realtimeBackend) return;
  realtimeBackend = value;
  writeRealtimeBackend(value);
  emit();
}

/* ─── React hooks ─────────────────────────────────────────────────── */

/** React hook reading whether vision (scene-awareness) is enabled.
 *  Re-renders on every store mutation. */
export function useVisionEnabled(): boolean {
  return useSyncExternalStore(subscribe, isVisionEnabled);
}

/** React hook reading whether long-term memory is enabled.
 *  Re-renders on every store mutation. */
export function useMemoryEnabled(): boolean {
  return useSyncExternalStore(subscribe, isMemoryEnabled);
}

/** React hook reading the selected realtime backend. Re-renders on
 *  every store mutation (drives the settings-panel selector). */
export function useRealtimeBackend(): RealtimeBackendKind {
  return useSyncExternalStore(subscribe, getRealtimeBackend);
}
