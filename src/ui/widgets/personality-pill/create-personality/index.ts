/**
 * Building blocks for the "create a personality" surface, split out of the
 * former `CreatePersonalityModal` god-component: shared constants/styles,
 * the logic hooks (generation progress, vibe roll), and the
 * presentational pieces (Hero, Fields, Actions).
 */
export { NAME_MAX, TAGLINE_MAX, VIBE_MAX, ctaSx, ideaBtnSx, shrinkLabelSlotProps } from './constants';

export { useVibeRoll } from './useVibeRoll';
export type { VibeRoll } from './useVibeRoll';

export { useVoiceAudition } from './useVoiceAudition';
export type { VoiceAudition } from './useVoiceAudition';

export { CreatePersonalityHero } from './Hero';
export type { CreatePersonalityHeroProps } from './Hero';
export { CreatePersonalityGenerating } from './Generating';
export type { CreatePersonalityGeneratingProps } from './Generating';
export { CreatePersonalityFields } from './Fields';
export type { CreatePersonalityFieldsProps } from './Fields';
export { CreatePersonalityActions, CreatePersonalityHeroActions } from './Actions';
export type {
  CreatePersonalityActionsProps,
  CreatePersonalityHeroActionsProps,
} from './Actions';
