/**
 * "Randomize" the vibe box: streams a one-line idea from the model straight
 * into the description field so it types itself out. If the model call fails
 * (e.g. no token) it silently falls back to a local idea, so the die always
 * does something. The in-flight stream is aborted if the form unmounts.
 *
 * Seeds ONLY the description - it does NOT author the whole persona (the user
 * then taps "Generate" for that).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { generateRandomVibe, streamRandomVibe } from '@/features/personalities';

export interface VibeRoll {
  /** True while a vibe is streaming in. */
  rolling: boolean;
  /** Clear the field and stream a fresh vibe into it. No-op if rolling. */
  roll: () => void;
}

/**
 * @param onVibe  Stable setter for the vibe text (receives the clamped value).
 * @param maxLen  Max characters to keep (mirrors the field's clamp).
 */
export function useVibeRoll(
  onVibe: (text: string) => void,
  maxLen: number,
): VibeRoll {
  const [rolling, setRolling] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const roll = useCallback(() => {
    if (rolling) return;
    setRolling(true);
    onVibe('');
    const controller = new AbortController();
    abortRef.current = controller;
    void streamRandomVibe({
      signal: controller.signal,
      onToken: full => onVibe(full.slice(0, maxLen)),
    })
      .then(final => {
        if (final) onVibe(final.slice(0, maxLen));
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        console.warn('[personalities] vibe stream failed, using local:', err);
        onVibe(generateRandomVibe().slice(0, maxLen));
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
        setRolling(false);
      });
  }, [rolling, onVibe, maxLen]);

  // Abort an in-flight vibe stream if the form unmounts mid-roll.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  return { rolling, roll };
}
