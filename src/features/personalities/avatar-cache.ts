/**
 * Avatars fetched from the robot, cached by the robot's `avatar_id`.
 *
 * One storage entry per avatar, not one blob for the whole catalog, so a quota
 * failure costs a single drawing instead of every one. The in-memory map also
 * serves hosts with no localStorage (vitest's node environment).
 */
const KEY_PREFIX = 'reachyMini.personalities.avatar.';

const memory = new Map<string, string>();

function safeStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function getCachedAvatar(avatarId: string): string | null {
  const hit = memory.get(avatarId);
  if (hit) return hit;
  try {
    const stored = safeStorage()?.getItem(KEY_PREFIX + avatarId) ?? null;
    if (stored) memory.set(avatarId, stored);
    return stored;
  } catch {
    return null;
  }
}

/** Cache the robot's SVG markup as an `<img src>`-ready data URI. */
export function cacheAvatar(avatarId: string, svg: string): string {
  const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  memory.set(avatarId, dataUri);
  try {
    safeStorage()?.setItem(KEY_PREFIX + avatarId, dataUri);
  } catch (err) {
    console.warn(`[personalities] could not cache avatar ${avatarId}:`, err);
  }
  return dataUri;
}
