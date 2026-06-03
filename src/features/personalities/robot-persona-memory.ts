/**
 * Per-robot personality memory.
 *
 * Remembers the last personality used with each robot so the discovery
 * list ("Your Reachies") can show every robot wearing the face it was
 * last paired with. Keyed by the robot's stable `hardware_id` when the
 * daemon exposes one, else its `peerId` (callers pass the fallback).
 *
 * Best-effort localStorage, like the rest of the personalities storage:
 * a single JSON map `{ robotKey: personaId }`, failures swallowed.
 */

const STORAGE_KEY = 'reachyMini.personalities.robotPersonaByKey';

function readMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** Personality last paired with this robot, or `null` if none. */
export function getRememberedPersonaId(robotKey: string | null | undefined): string | null {
  if (!robotKey) return null;
  return readMap()[robotKey] ?? null;
}

/** Record `robot -> persona`. No-op without a key or when unchanged. */
export function rememberRobotPersona(
  robotKey: string | null | undefined,
  personaId: string,
): void {
  if (!robotKey || !personaId) return;
  const map = readMap();
  if (map[robotKey] === personaId) return;
  map[robotKey] = personaId;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // best-effort: a failed write just means the face won't persist
  }
}
