/**
 * Public surface of the personalities feature.
 *
 * Engine-side consumers (settings, conversation-engine) should import
 * the `getActivePersonality` resolver. UI consumers should pull the
 * React hooks (`useActivePersonality`, `usePersonalitiesCatalog`) and
 * the mutation helpers (`setActivePersonality`, `addCustomPersonality`).
 */
export type { CustomPersonalityInput, PersonaVoices, Personality, PersonalityKind } from './types';
export {
  BUILTIN_PERSONALITIES,
  DEFAULT_AVATAR_URL,
  DEFAULT_GLOW,
  DEFAULT_PERSONALITY_ID,
  GLOW_PALETTE,
  getDefaultPersonality,
  resolvePersonaVoice,
} from './builtin';
export {
  generatePersonality,
  generateRandomPersonality,
  generateRandomVibe,
  streamRandomVibe,
  GeneratePersonalityError,
} from './generate';
export type {
  GeneratedPersonality,
  GeneratePersonalityReason,
} from './generate';
export {
  addCustomPersonality,
  clearAvatarPending,
  getActivePersonality,
  markAvatarPending,
  removeCustomPersonality,
  resolvePersonalityById,
  setActivePersonality,
  setCustomPersonalityAvatar,
  subscribe as subscribePersonalities,
  updateCustomPersonality,
  useActivePersonality,
  useIsAvatarPending,
  usePersonalitiesCatalog,
} from './store';
export {
  getRememberedPersonaId,
  rememberRobotPersona,
} from './robot-persona-memory';
export {
  clearPersonaDraft,
  setPersonaDraft,
  usePersonaDraft,
} from './draft';
export type { PersonaDraft as PersonaDraftPreview } from './draft';
export {
  STICKER_AVATAR_MODEL,
  craftStickerTheme,
  generateStickerAvatar,
  fetchStickerQueueSize,
  StickerOverloadedError,
} from './sticker-avatar';
export type { StickerAvatarResult, StickerStatus } from './sticker-avatar';
