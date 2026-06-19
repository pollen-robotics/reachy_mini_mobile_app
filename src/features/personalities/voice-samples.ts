/**
 * Voice preview samples.
 *
 * Short bundled audio clips, one per Qwen3-TTS CustomVoice speaker, so the
 * create-personality picker can let the user hear a voice before committing
 * to it instead of guessing from its name.
 *
 * Why bundled clips (not live TTS)
 * --------------------------------
 * The mobile shell talks to the realtime backend, not a standalone TTS
 * preview endpoint. A network round-trip on every tap would also make the
 * picker feel sluggish and provider-dependent. These clips are generated
 * once, converted to compact MP3 assets, and shipped through Vite as hashed
 * URLs so playback is instant and works offline.
 *
 * Keep the keys in lockstep with `AVAILABLE_VOICES` in `builtin.ts`.
 */
import aiden from '@/assets/voices/aiden.mp3';
import dylan from '@/assets/voices/dylan.mp3';
import eric from '@/assets/voices/eric.mp3';
import onoAnna from '@/assets/voices/ono_anna.mp3';
import ryan from '@/assets/voices/ryan.mp3';
import serena from '@/assets/voices/serena.mp3';
import sohee from '@/assets/voices/sohee.mp3';
import uncleFu from '@/assets/voices/uncle_fu.mp3';
import vivian from '@/assets/voices/vivian.mp3';

import { snapVoice, type VoiceId } from './builtin';

/** Voice id -> bundled sample clip URL. */
export const VOICE_SAMPLES: Readonly<Record<VoiceId, string>> = {
  Aiden: aiden,
  Ryan: ryan,
  Dylan: dylan,
  Eric: eric,
  Ono_Anna: onoAnna,
  Serena: serena,
  Sohee: sohee,
  Uncle_Fu: uncleFu,
  Vivian: vivian,
};

/** Resolve a bundled sample URL for a voice id (snapping unknown/legacy
 *  ids onto the HF catalog so a stale value still auditions). */
export function getVoiceSampleUrl(voice: string): string | null {
  const normalized = snapVoice(voice) as VoiceId;
  return VOICE_SAMPLES[normalized] ?? null;
}
