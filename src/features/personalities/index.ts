/**
 * Public surface of the personalities feature.
 *
 * Engine-side consumers (settings, conversation-engine) should import
 * the `getActivePersonality` resolver. UI consumers should pull the
 * React hooks (`useActivePersonality`, `usePersonalitiesCatalog`) and
 * the mutation helpers (`setActivePersonality`, `addCustomPersonality`).
 */
export type {
  CustomPersonalityInput,
  Personality,
  PersonalityKind,
} from './types';
export {
  AVAILABLE_VOICES,
  BUILTIN_PERSONALITIES,
  DEFAULT_AVATAR_URL,
  DEFAULT_GLOW,
  DEFAULT_PERSONALITY_ID,
  GLOW_PALETTE,
  VOICE_DESCRIPTIONS,
  getDefaultPersonality,
  resolvePersonaVoice,
} from './builtin';
export type { VoiceId } from './builtin';
export { VOICE_SAMPLES, getVoiceSampleUrl } from './voice-samples';
export {
  generatePersonality,
  generateRandomPersonality,
  generateRandomVibe,
  streamRandomVibe,
  streamPersonality,
  GeneratePersonalityError,
} from './generate';
export type {
  GeneratedPersonality,
  GeneratePersonalityReason,
  StreamPersonalityOptions,
} from './generate';
export { presentationKey } from './from-robot';
export { syncPersonalitiesToRobot } from './sync';
export {
  addCustomPersonality,
  clearAvatarPending,
  getActivePersonality,
  getActivePersonalityId,
  markAvatarPending,
  removeCustomPersonality,
  reorderCustomPersonalities,
  resolvePersonalityById,
  setActivePersonality,
  setCustomPersonalityAvatar,
  subscribe as subscribePersonalities,
  updateCustomPersonality,
  useActivePersonality,
  useAvatarPendingSince,
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
