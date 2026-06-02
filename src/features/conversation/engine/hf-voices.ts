/** Qwen3-TTS CustomVoice speakers exposed by the deployed HF backend. */
export const HF_AVAILABLE_VOICES = [
  'Aiden',
  'Ryan',
  'Dylan',
  'Eric',
  'Ono_Anna',
  'Serena',
  'Sohee',
  'Uncle_Fu',
  'Vivian',
] as const;

export type HfVoiceId = (typeof HF_AVAILABLE_VOICES)[number];

export const HF_DEFAULT_VOICE: HfVoiceId = 'Aiden';

export function normalizeHfVoice(value: string | null | undefined): HfVoiceId {
  const candidate = (value ?? '').trim().toLowerCase();
  const match = HF_AVAILABLE_VOICES.find(
    (voice) => voice.toLowerCase() === candidate,
  );
  return match ?? HF_DEFAULT_VOICE;
}
