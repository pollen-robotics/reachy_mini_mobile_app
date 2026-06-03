/**
 * Building blocks for the "create a personality" surface, split out of the
 * former `CreatePersonalityModal` god-component: shared constants/styles,
 * the logic hooks (generation progress, voice audition, vibe roll), and the
 * presentational pieces (Hero, Fields, Actions).
 */
export { GEN_STEPS, NAME_MAX, TAGLINE_MAX, VIBE_MAX, ctaSx, diceBtnSx, genBtnSx, shrinkLabelSlotProps } from './constants';

export { useGenerationProgress } from './useGenerationProgress';
export type { GenerationProgress } from './useGenerationProgress';
export { useVibeRoll } from './useVibeRoll';
export type { VibeRoll } from './useVibeRoll';
export { useVoiceAudition } from './useVoiceAudition';
export type { VoiceAudition } from './useVoiceAudition';

export { CreatePersonalityHero } from './Hero';
export type { CreatePersonalityHeroProps } from './Hero';
export { CreatePersonalityFields } from './Fields';
export type { CreatePersonalityFieldsProps } from './Fields';
export { CreatePersonalityActions } from './Actions';
export type { CreatePersonalityActionsProps } from './Actions';
