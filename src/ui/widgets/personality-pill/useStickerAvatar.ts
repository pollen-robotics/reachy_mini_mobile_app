/**
 * useStickerAvatar - drives one sticker-avatar generation for the
 * personality authoring form.
 *
 * Responsibilities:
 *   - `craft()`    : ask the LLM for a short visual theme and prefill
 *                    the editable theme field.
 *   - `generate()` : run the ~1-minute sticker generation, exposing
 *                    `status` + `queueSize` for the cooking UI and
 *                    `result.dataUri` when done.
 *   - `adoptPersona(id)` : hand the in-flight generation a persona id
 *                    so it can patch the avatar in AFTER the form has
 *                    submitted + unmounted. This is what makes the
 *                    "submit now, sticker lands later" UX possible:
 *                    the persona is created immediately with the
 *                    default avatar, then swapped via the store once
 *                    the sticker resolves.
 *
 * The generation promise is intentionally NOT aborted on unmount once
 * a persona has been adopted - we want it to finish and patch. If the
 * user closes the form WITHOUT submitting, the in-flight request is
 * aborted on cleanup.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  StickerOverloadedError,
  clearAvatarPending,
  craftStickerTheme,
  generateStickerAvatar,
  markAvatarPending,
  setCustomPersonalityAvatar,
  type StickerStatus,
} from '@/features/personalities';

export type StickerError = 'overloaded' | 'failed' | null;

interface PersonaDraft {
  name: string;
  tagline: string;
  instructions: string;
}

export interface UseStickerAvatar {
  /** Editable visual theme sent to the sticker API. */
  theme: string;
  setTheme: (value: string) => void;
  status: StickerStatus;
  /** Server-side queue length captured when generation started (0 = no wait). */
  queueSize: number;
  /** Inlined avatar data URI once `status === 'done'`. */
  dataUri: string | null;
  error: StickerError;
  /** Whether the LLM is currently composing the theme. */
  crafting: boolean;
  /** Prefill `theme` from the persona via the LLM (best-effort). Pass
   *  `force` to overwrite a theme the user has already edited. */
  craft: (draft: PersonaDraft, force?: boolean) => void;
  /** Kick off generation. Uses `themeOverride` when given, else the
   *  current `theme` state. */
  generate: (themeOverride?: string) => void;
  /** Abort an in-flight generation and reset to idle. */
  cancel: () => void;
  /** Adopt a persona id so a late-resolving sticker patches it in. */
  adoptPersona: (personaId: string) => void;
  /** Re-craft a fresh theme from the persona then generate a new
   *  avatar for an EXISTING persona id, patching it in when done. Used
   *  by the edit form's "Regenerate" affordance. Marks the persona as
   *  cooking so the band + picker tiles show a ring meanwhile. */
  regenerateFor: (personaId: string, draft: PersonaDraft) => void;
}

export function useStickerAvatar(): UseStickerAvatar {
  const [theme, setTheme] = useState('');
  const [status, setStatus] = useState<StickerStatus>('idle');
  const [queueSize, setQueueSize] = useState(0);
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [error, setError] = useState<StickerError>(null);
  const [crafting, setCrafting] = useState(false);

  const mountedRef = useRef(true);
  const genControllerRef = useRef<AbortController | null>(null);
  const craftControllerRef = useRef<AbortController | null>(null);
  const adoptedIdRef = useRef<string | null>(null);
  // True between a generation kicking off and it settling. Lets
  // `adoptPersona` decide whether to mark the persona as "cooking" (an
  // in-flight generation) vs. patch immediately (already resolved).
  const inFlightRef = useRef(false);
  // Holds a resolved data URI that arrived BEFORE a persona was
  // adopted but AFTER submit - lets `adoptPersona` patch retroactively.
  const pendingDataUriRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      craftControllerRef.current?.abort();
      // Only abort generation if no persona is waiting for it; an
      // adopted generation must outlive the form to patch the avatar.
      if (!adoptedIdRef.current) genControllerRef.current?.abort();
    };
  }, []);

  const craft = useCallback((draft: PersonaDraft, force = false) => {
    craftControllerRef.current?.abort();
    const controller = new AbortController();
    craftControllerRef.current = controller;
    setCrafting(true);
    void craftStickerTheme(draft, controller.signal)
      .then(result => {
        if (!mountedRef.current || controller.signal.aborted) return;
        // Don't clobber a theme the user has already typed into,
        // unless an explicit refresh (`force`) was requested.
        setTheme(prev => (force || prev.trim().length === 0 ? result : prev));
      })
      .finally(() => {
        if (mountedRef.current && !controller.signal.aborted) setCrafting(false);
      });
  }, []);

  const generate = useCallback(
    (themeOverride?: string) => {
    const prompt = (themeOverride ?? theme).trim();
    if (!prompt) return;
    if (themeOverride !== undefined) setTheme(prompt);
    genControllerRef.current?.abort();
    const controller = new AbortController();
    genControllerRef.current = controller;
    adoptedIdRef.current = null;
    pendingDataUriRef.current = null;
    inFlightRef.current = true;
    setError(null);
    setDataUri(null);
    setQueueSize(0);
    setStatus('generating');

    void generateStickerAvatar(prompt, {
      signal: controller.signal,
      onStatus: (next, size) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        setStatus(next);
        setQueueSize(size);
      },
    })
      .then(result => {
        inFlightRef.current = false;
        // Patch a persona that was submitted while we cooked. This also
        // clears its "cooking" flag in the store (so the band + tiles
        // drop the ring and show the new avatar).
        const adoptedId = adoptedIdRef.current;
        if (adoptedId) {
          setCustomPersonalityAvatar(adoptedId, result.dataUri);
        } else {
          pendingDataUriRef.current = result.dataUri;
        }
        if (!mountedRef.current) return;
        setDataUri(result.dataUri);
        setStatus('done');
      })
      .catch(err => {
        inFlightRef.current = false;
        if (controller.signal.aborted) return;
        // A failed generation must not leave the persona stuck
        // "cooking" forever on the band / tiles.
        const adoptedId = adoptedIdRef.current;
        if (adoptedId) clearAvatarPending(adoptedId);
        if (!mountedRef.current) return;
        setError(err instanceof StickerOverloadedError ? 'overloaded' : 'failed');
        setStatus('error');
      });
  }, [theme]);

  const cancel = useCallback(() => {
    genControllerRef.current?.abort();
    inFlightRef.current = false;
    if (adoptedIdRef.current) clearAvatarPending(adoptedIdRef.current);
    if (!mountedRef.current) return;
    setStatus('idle');
    setQueueSize(0);
    setError(null);
  }, []);

  const adoptPersona = useCallback((personaId: string) => {
    adoptedIdRef.current = personaId;
    // If the sticker already resolved between submit and adoption,
    // patch immediately.
    if (pendingDataUriRef.current) {
      setCustomPersonalityAvatar(personaId, pendingDataUriRef.current);
    } else if (inFlightRef.current) {
      // Still cooking - flag the persona so surfaces outside this form
      // (band, picker tiles) show the cooking ring until it lands.
      markAvatarPending(personaId);
    }
  }, []);

  const regenerateFor = useCallback(
    (personaId: string, draft: PersonaDraft) => {
      craftControllerRef.current?.abort();
      const controller = new AbortController();
      craftControllerRef.current = controller;
      setCrafting(true);
      // Adopt + generate AFTER the theme resolves. `generate` resets
      // `adoptedIdRef` to null at its start, so we (re)adopt right after
      // calling it; the eventual `.then` then patches the persona by id.
      const kick = (themePrompt: string) => {
        const t = themePrompt.trim() || draft.name.trim();
        if (!t) return;
        generate(t);
        adoptedIdRef.current = personaId;
        markAvatarPending(personaId);
      };
      void craftStickerTheme(draft, controller.signal)
        .then(result => {
          if (controller.signal.aborted) return;
          kick(result);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          kick('');
        })
        .finally(() => {
          if (mountedRef.current && !controller.signal.aborted) setCrafting(false);
        });
    },
    [generate],
  );

  return {
    theme,
    setTheme,
    status,
    queueSize,
    dataUri,
    error,
    crafting,
    craft,
    generate,
    cancel,
    adoptPersona,
    regenerateFor,
  };
}
