/**
 * Public surface of the conversation-settings feature.
 *
 * Engine-side: `isVisionEnabled()` / `isMemoryEnabled()` (read lazily
 * at connect time). UI side: the `useVisionEnabled()` /
 * `useMemoryEnabled()` hooks + the `setVisionEnabled()` /
 * `setMemoryEnabled()` mutations for the settings panel toggles.
 */
export {
  getRealtimeBackend,
  isMemoryEnabled,
  isVisionEnabled,
  setMemoryEnabled,
  setRealtimeBackend,
  setVisionEnabled,
  subscribe as subscribeConversationSettings,
  useMemoryEnabled,
  useRealtimeBackend,
  useVisionEnabled,
} from './store';
