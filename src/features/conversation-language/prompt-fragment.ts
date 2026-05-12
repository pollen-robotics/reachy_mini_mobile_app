/**
 * System-prompt fragment for the conversation language.
 *
 * Appended verbatim to the personality instructions in
 * `composeInstructions()` (see `conversation-engine.ts`). The
 * fragment lives here, in a leaf file with zero React / engine
 * imports, so unit tests can pin its exact wording without
 * pulling the rest of the module graph.
 *
 * Two rules the wording is intentionally explicit about:
 *
 *   1. Default to the selected language: every reply, including
 *      the very first audio chunk after handshake, should be in
 *      <Language>. Without this nudge the model defaults to the
 *      voice's training distribution (English-heavy).
 *
 *   2. Honour explicit user override: when the user asks "switch
 *      to <X>" or simply starts speaking <X>, follow them. This
 *      is what makes the "ask the bot to change language" UX
 *      flow work without a tool call - the model decides, we
 *      just permit it in the system prompt.
 *
 * Wording stays in English (the rest of the system prompt is
 * also English) so the model reads a coherent context regardless
 * of the target output language.
 */
import { getLanguageMeta } from './catalog';
import type { LanguageId } from './types';

/**
 * Build the language fragment to append to the personality
 * instructions. Returns a single trimmed paragraph; the caller
 * is responsible for the blank-line separator (handled by
 * `composeInstructions`'s `\n\n` joiner).
 */
export function getLanguagePromptAppendix(id: LanguageId): string {
  const meta = getLanguageMeta(id);
  return [
    `Language: reply in ${meta.nameEnglish} by default,`,
    `including your very first response after the conversation starts.`,
    `If the user explicitly asks you to switch language, or clearly`,
    `addresses you in another language, follow them for the rest of the`,
    `conversation - the user is in charge of the language.`,
  ].join(' ');
}
