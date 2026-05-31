/**
 * Voice preview samples.
 *
 * Short (~3 s) audio clips, one per OpenAI Realtime voice, so the
 * create-personality picker can let the user *hear* a voice before
 * committing to it instead of guessing from its name.
 *
 * Why bundled clips (not live TTS)
 * ────────────────────────────────
 * The mobile shell only ever mints short-lived *realtime* ephemeral
 * keys (see `engine/ephemeral-key.ts`); it has no standalone TTS
 * credential, and we don't want a network round-trip (or per-tap cost)
 * just to audition a voice. So the clips are generated once, offline,
 * with OpenAI's `gpt-4o-mini-tts` (all 10 voices say the same line:
 * "Hi, I am Reachy Mini. This is how I sound.") and shipped as static
 * assets. Vite turns each import into a hashed URL string at build
 * time, so playback is instant and works fully offline.
 *
 * Keep the keys in lockstep with `AVAILABLE_VOICES` in `builtin.ts`.
 */
import alloy from '@/assets/voices/alloy.mp3';
import ash from '@/assets/voices/ash.mp3';
import ballad from '@/assets/voices/ballad.mp3';
import cedar from '@/assets/voices/cedar.mp3';
import coral from '@/assets/voices/coral.mp3';
import echo from '@/assets/voices/echo.mp3';
import marin from '@/assets/voices/marin.mp3';
import sage from '@/assets/voices/sage.mp3';
import shimmer from '@/assets/voices/shimmer.mp3';
import verse from '@/assets/voices/verse.mp3';

/** Voice id -> bundled sample clip URL. */
export const VOICE_SAMPLES: Readonly<Record<string, string>> = {
  alloy,
  ash,
  ballad,
  cedar,
  coral,
  echo,
  marin,
  sage,
  shimmer,
  verse,
};

/** Resolve a sample URL for a voice id, or `null` if none is bundled. */
export function getVoiceSampleUrl(voice: string): string | null {
  return VOICE_SAMPLES[voice] ?? null;
}
