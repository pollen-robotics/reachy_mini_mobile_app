/**
 * Voice audition: plays a short bundled sample for a voice so the user hears
 * it before committing. A single shared `<Audio>` element is reused; starting
 * a new sample (or re-tapping the same voice) stops the previous clip first.
 * The clip is paused + released when the hosting form unmounts.
 *
 * This hook owns playback ONLY - selecting the voice (writing form state) is
 * the caller's job, so the form keeps a single source of truth for `voice`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { getVoiceSampleUrl } from '@/features/personalities';

export interface VoiceAudition {
  /** The voice whose sample is currently playing, or null. */
  playingVoice: string | null;
  /** Stop any current clip and play the sample for `voice` (if bundled). */
  playSample: (voice: string) => void;
}

export function useVoiceAudition(): VoiceAudition {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);

  const playSample = useCallback((voice: string) => {
    const current = audioRef.current;
    if (current) {
      current.pause();
      current.currentTime = 0;
    }
    setPlayingVoice(null);

    const url = getVoiceSampleUrl(voice);
    if (!url) return;

    const audio = new Audio(url);
    audioRef.current = audio;
    audio.addEventListener('ended', () =>
      setPlayingVoice(prev => (prev === voice ? null : prev)),
    );
    setPlayingVoice(voice);
    void audio
      .play()
      .catch(() => setPlayingVoice(prev => (prev === voice ? null : prev)));
  }, []);

  // Stop + release any in-flight clip when the form unmounts (e.g. the user
  // closes it via the band's "✕" while a sample is still playing).
  useEffect(
    () => () => {
      const audio = audioRef.current;
      if (audio) audio.pause();
      audioRef.current = null;
    },
    [],
  );

  return { playingVoice, playSample };
}
