/**
 * Public surface of the conversation-settings feature.
 *
 * Engine-side: `isVisionEnabled()` / `isMemoryEnabled()` (read lazily
 * at connect time). UI side: the `useVisionEnabled()` /
 * `useMemoryEnabled()` hooks + the `setVisionEnabled()` /
 * `setMemoryEnabled()` mutations for the settings panel toggles.
 */
export {
  isMemoryEnabled,
  isVisionEnabled,
  setMemoryEnabled,
  setVisionEnabled,
  subscribe as subscribeConversationSettings,
  useMemoryEnabled,
  useVisionEnabled,
} from './store';
