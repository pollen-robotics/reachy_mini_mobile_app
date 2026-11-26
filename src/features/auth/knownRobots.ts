/**
 * Robots this phone has seen on the user's account.
 *
 * Central lists the robots that are online right now, nothing else. A robot
 * that is off, on a Wi-Fi it can't join or mid-restart simply vanishes from
 * that list, and an empty list reads like "no robot on this account", which
 * is the first-setup invite. Remembering what was listed lets the robot list
 * keep those robots as offline rows, with a way to bring them back, instead.
 *
 * Kept per Hugging Face username (two accounts on one phone see their own
 * robots) and keyed by `hardware_id`: the peer id changes on every
 * registration, so an entry without a hardware id could never be matched
 * again and is not remembered. Local to the phone, like the rest of the
 * mobile preferences.
 */
import { useSyncExternalStore } from 'react';

import {
  extractRobotHardwareId,
  extractRobotName,
  extractRobotTransport,
  type CentralRobotEntry,
  type RobotTransport,
} from './fetchRobotsFromCentral';

const STORAGE_KEY = 'reachy.knownRobots';

/** How stale `lastSeen` may get before a sighting is written again. */
const LAST_SEEN_RESOLUTION_MS = 60_000;

export interface KnownRobot {
  hardwareId: string;
  name: string;
  /** The variant it advertised, so the offline help fits it. */
  transport: RobotTransport;
  /** Epoch ms of the last time central listed it. */
  lastSeen: number;
}

type Book = Record<string, KnownRobot[]>;

const EMPTY: readonly KnownRobot[] = Object.freeze([]);
const listeners = new Set<() => void>();
let book: Book = read();
/** Per-username snapshots, stable between writes for `useSyncExternalStore`. */
let snapshots = new Map<string, readonly KnownRobot[]>();

function read(): Book {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Book) : {};
  } catch {
    return {};
  }
}

function write(next: Book): void {
  book = next;
  snapshots = new Map();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private browsing / full storage: the list still works for this run.
  }
  for (const listener of listeners) listener();
}

/** The robots remembered for `username`, most recently seen first. */
export function getKnownRobots(username: string | null): readonly KnownRobot[] {
  if (!username) return EMPTY;
  const cached = snapshots.get(username);
  if (cached) return cached;
  const list = [...(book[username] ?? [])].sort((a, b) => b.lastSeen - a.lastSeen);
  const frozen = list.length ? Object.freeze(list) : EMPTY;
  snapshots.set(username, frozen);
  return frozen;
}

/**
 * Record the robots central lists for `username` right now. Writes only
 * when something a reader would notice changed: a new robot, a new name or
 * variant, or a `lastSeen` more than a minute old.
 */
export function rememberRobots(
  username: string | null,
  robots: readonly CentralRobotEntry[],
  now: number = Date.now()
): void {
  if (!username) return;
  const current = book[username] ?? [];
  const byId = new Map(current.map(robot => [robot.hardwareId, robot]));
  let changed = false;
  for (const entry of robots) {
    const hardwareId = extractRobotHardwareId(entry);
    if (!hardwareId) continue;
    const seen: KnownRobot = {
      hardwareId,
      name: extractRobotName(entry),
      transport: extractRobotTransport(entry),
      lastSeen: now,
    };
    const previous = byId.get(hardwareId);
    if (
      previous &&
      previous.name === seen.name &&
      previous.transport === seen.transport &&
      now - previous.lastSeen < LAST_SEEN_RESOLUTION_MS
    ) {
      continue;
    }
    byId.set(hardwareId, seen);
    changed = true;
  }
  if (changed) write({ ...book, [username]: [...byId.values()] });
}

/** Drop a robot: the user asked to, or it left the account. */
export function forgetRobot(username: string | null, hardwareId: string): void {
  if (!username) return;
  const current = book[username] ?? [];
  const next = current.filter(robot => robot.hardwareId !== hardwareId);
  if (next.length !== current.length) write({ ...book, [username]: next });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React view of `getKnownRobots(username)`. */
export function useKnownRobots(username: string | null): readonly KnownRobot[] {
  return useSyncExternalStore(subscribe, () => getKnownRobots(username));
}

/** Test hook: forget everything, in memory and on disk. */
export function resetKnownRobotsForTests(): void {
  write({});
}
