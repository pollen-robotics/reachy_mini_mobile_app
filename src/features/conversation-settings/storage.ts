/**
 * Conversation-settings persistence layer.
 *
 * Two boolean localStorage slots, both defaulting to ON so a fresh
 * install keeps today's behaviour (scene-awareness + long-term
 * memory enabled):
 *
 *   `reachyMini.conversationSettings.visionEnabled`  ("true" | "false")
 *   `reachyMini.conversationSettings.memoryEnabled`  ("true" | "false")
 *
 * Read once at module load by the store and on every conversation
 * (re)connect by the engine getters. Failures (private mode, quota,
 * missing localStorage in test envs) are swallowed with a single warn
 * line; the in-memory store stays authoritative for the session.
 */

import type { RealtimeBackendKind } from '@/features/conversation/engine/realtime/types';

const VISION_KEY = 'reachyMini.conversationSettings.visionEnabled';
const MEMORY_KEY = 'reachyMini.conversationSettings.memoryEnabled';
const BACKEND_KEY = 'reachyMini.conversationSettings.realtimeBackend';

/** Default realtime provider. Hugging Face is the shipped default; the
 *  OpenAI path is opt-in via the settings toggle. */
const DEFAULT_BACKEND: RealtimeBackendKind = 'huggingface';

function safeStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

/** Read a boolean slot. Anything other than the literal `"false"`
 *  resolves to the default-ON `true` (missing key, typo, empty). */
function readBool(key: string): boolean {
  const storage = safeStorage();
  if (!storage) return true;
  try {
    return storage.getItem(key) !== 'false';
  } catch (err) {
    console.warn('[conversation-settings] failed to read', key, err);
    return true;
  }
}

function writeBool(key: string, value: boolean): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(key, value ? 'true' : 'false');
  } catch (err) {
    console.warn('[conversation-settings] failed to write', key, err);
  }
}

export function readVisionEnabled(): boolean {
  return readBool(VISION_KEY);
}

export function writeVisionEnabled(value: boolean): void {
  writeBool(VISION_KEY, value);
}

export function readMemoryEnabled(): boolean {
  return readBool(MEMORY_KEY);
}

export function writeMemoryEnabled(value: boolean): void {
  writeBool(MEMORY_KEY, value);
}

/** Read the selected realtime backend. Unknown / missing values fall
 *  back to the shipped default (`huggingface`). */
export function readRealtimeBackend(): RealtimeBackendKind {
  const storage = safeStorage();
  if (!storage) return DEFAULT_BACKEND;
  try {
    const raw = storage.getItem(BACKEND_KEY);
    return raw === 'openai' || raw === 'huggingface' ? raw : DEFAULT_BACKEND;
  } catch (err) {
    console.warn('[conversation-settings] failed to read', BACKEND_KEY, err);
    return DEFAULT_BACKEND;
  }
}

export function writeRealtimeBackend(value: RealtimeBackendKind): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(BACKEND_KEY, value);
  } catch (err) {
    console.warn('[conversation-settings] failed to write', BACKEND_KEY, err);
  }
}
