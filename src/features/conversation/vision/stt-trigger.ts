/**
 * STT keyword detector + debounce.
 *
 * Pure, no side-effects beyond an in-memory timestamp. The poller
 * owns the actual subscription to the bridge's user-transcript port
 * and feeds raw transcripts in here; this module decides whether a
 * given transcript should fire a capture.
 *
 * Matching rules (see `docs/VISION.md` § 9):
 *   - lowercase + strip diacritics on both haystack and needles
 *   - whole-word match via word-boundary regex
 *   - first-match-wins (we don't care which keyword triggered, only
 *     whether one did)
 *
 * Debounce: 5 s (`triggerDebounceMs`). The first matching transcript
 * fires the callback immediately; subsequent matches within the
 * window are swallowed.
 */

import { VISION_CONFIG } from "./config";

export interface SttTrigger {
  /** Feed a finalised user transcript. Returns `true` when the
   *  trigger actually fired (i.e. matched + not debounced),
   *  `false` otherwise. Mostly useful for tests / logs - the
   *  poller observes the configured `onTrigger` callback directly. */
  feed: (text: string) => boolean;
  /** Force-reset the debounce window. Called by the poller after a
   *  successful periodic capture so a near-coincident user trigger
   *  doesn't get unfairly swallowed. */
  resetDebounce: () => void;
}

export interface CreateSttTriggerOptions {
  onTrigger: (text: string, matchedKeyword: string) => void;
}

export function createSttTrigger(opts: CreateSttTriggerOptions): SttTrigger {
  const compiled = compileKeywords(VISION_CONFIG.triggerKeywords);
  let lastFiredAt = 0;

  const feed = (text: string): boolean => {
    if (!text) return false;
    const normalised = normalise(text);
    if (!normalised) return false;

    let matched: string | null = null;
    for (const { needle, regex } of compiled) {
      if (regex.test(normalised)) {
        matched = needle;
        break;
      }
    }
    if (!matched) return false;

    const now = performance.now();
    if (now - lastFiredAt < VISION_CONFIG.triggerDebounceMs) {
      console.debug(
        `[vision] stt-trigger matched "${matched}" but debounced (last fired ${Math.round(
          now - lastFiredAt,
        )}ms ago)`,
      );
      return false;
    }
    lastFiredAt = now;
    try {
      opts.onTrigger(text, matched);
    } catch (err) {
      console.warn("[vision] stt-trigger onTrigger callback threw:", err);
    }
    return true;
  };

  const resetDebounce = (): void => {
    lastFiredAt = performance.now();
  };

  return { feed, resetDebounce };
}

interface CompiledKeyword {
  needle: string;
  regex: RegExp;
}

/**
 * Pre-compile the keyword list into normalised-text regexes. Each
 * regex is anchored with `\b` so a keyword can't match inside a
 * longer word (e.g. `regarde` shouldn't match "regardé" - which the
 * diacritic strip already collapses to "regarde", but the word
 * boundary protects against compounds like "regardement").
 */
function compileKeywords(keywords: readonly string[]): CompiledKeyword[] {
  return keywords
    .map((kw) => normalise(kw))
    .filter((kw) => kw.length > 0)
    .map((needle) => ({
      needle,
      regex: new RegExp(`(?:^|\\W)${escapeRegex(needle)}(?:\\W|$)`, "i"),
    }));
}

/** Lowercase, strip diacritics, collapse whitespace. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
