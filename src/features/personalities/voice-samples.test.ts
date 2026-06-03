import { describe, expect, it } from 'vitest';

import { AVAILABLE_VOICES } from './builtin';
import { VOICE_SAMPLES, getVoiceSampleUrl } from './voice-samples';

describe('voice samples', () => {
  it('bundles a preview clip for every available voice', () => {
    expect(Object.keys(VOICE_SAMPLES)).toEqual([...AVAILABLE_VOICES]);

    for (const voice of AVAILABLE_VOICES) {
      expect(getVoiceSampleUrl(voice)).toBe(VOICE_SAMPLES[voice]);
      expect(typeof VOICE_SAMPLES[voice]).toBe('string');
      expect(VOICE_SAMPLES[voice].length).toBeGreaterThan(0);
    }
  });

  it('resolves legacy voice aliases through the normalized backend voice', () => {
    expect(getVoiceSampleUrl('alloy')).toBe(VOICE_SAMPLES.Aiden);
    expect(getVoiceSampleUrl('shimmer')).toBe(VOICE_SAMPLES.Vivian);
  });
});
