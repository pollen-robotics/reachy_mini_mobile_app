/**
 * Public surface of the personalities feature.
 *
 * Engine-side consumers (settings, conversation-engine) should import
 * the `getActivePersonality` resolver. UI consumers should pull the
 * React hooks (`useActivePersonality`, `usePersonalitiesCatalog`) and
 * the mutation helpers (`setActivePersonality`, `addCustomPersonality`).
 */
export type { CustomPersonalityInput, Personality, PersonalityKind } from './types';
export {
  AVAILABLE_VOICES,
  BUILTIN_PERSONALITIES,
  DEFAULT_AVATAR_URL,
  DEFAULT_GLOW,
  DEFAULT_PERSONALITY_ID,
  GLOW_PALETTE,
  getDefaultPersonality,
} from './builtin';
export type { VoiceId } from './builtin';
export { VOICE_SAMPLES, getVoiceSampleUrl } from './voice-samples';
export {
  addCustomPersonality,
  getActivePersonality,
  removeCustomPersonality,
  resolvePersonalityById,
  setActivePersonality,
  subscribe as subscribePersonalities,
  updateCustomPersonality,
  useActivePersonality,
  usePersonalitiesCatalog,
} from './store';
