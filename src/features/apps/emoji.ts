/**
 * Emoji glyph for an app catalog entry.
 *
 * The HF Space convention is to declare an `emoji:` field in the
 * Space README front-matter; the catalog payload exposes it as
 * `extra.cardData.emoji`. We keep it as a simple string (the actual
 * emoji glyph) and fall back to a generic glyph when missing:
 *   - 📦 for Python apps (the catalog's default Reachy app shape),
 *   - 🌐 for other Spaces (gradio / static / unknown).
 *
 * Some catalog entries list MULTIPLE emojis in `cardData.emoji`
 * (e.g. `🎵🎤`); we keep only the first by spreading the string and
 * taking element 0, which is codepoint-aware (handles flags + skin-
 * toned hands without splitting them).
 *
 * Centralised here so the apps list tiles (AppCompactTile,
 * AppPinnedTile) and the in-iframe top bar (AppIframeOverlay)
 * render the same glyph for the same app without duplicating
 * the fallback logic.
 */
import type { AppEntry } from './types';

export function readAppEmoji(app: AppEntry): string {
  const cardData = app.extra?.cardData as { emoji?: string } | undefined;
  const isPythonApp = (app.extra?.isPythonApp as boolean | undefined) !== false;
  const raw = cardData?.emoji || (isPythonApp ? '📦' : '🌐');
  return [...raw][0] ?? '📦';
}
