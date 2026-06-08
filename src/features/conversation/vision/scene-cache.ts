/**
 * Last-scene freshness cache.
 *
 * A tiny in-memory holder for the most recent VLM description, written
 * and read by the on-demand `look()` path to decide whether a
 * brand-new capture + VLM round-trip is actually warranted.
 *
 * Why: when the model calls the `look` tool twice in quick succession,
 * grabbing a fresh frame and paying the ~1-2 s VLM latency again buys
 * nothing - the scene almost certainly hasn't changed. `look()` reuses
 * the cached description if it's younger than `lookCacheFreshnessMs`,
 * so repeated/near-coincident looks are cheap and instant.
 *
 * Timestamps use `performance.now()` (monotonic) so they're immune to
 * wall-clock jumps; ages are therefore always non-negative.
 */

import type { SceneTrigger } from "./types";

export interface SceneSnapshot {
  /** The sanitised VLM description text. */
  description: string;
  /** `performance.now()` at the moment the description landed. */
  at: number;
  /** Which capture path produced it. */
  trigger: SceneTrigger;
}

export interface SceneCache {
  /** Latest snapshot, or `null` if nothing has been described yet. */
  get: () => SceneSnapshot | null;
  /** Record a fresh description, stamping it with the current time. */
  set: (description: string, trigger: SceneTrigger) => void;
  /** Milliseconds since the last `set`, or `Infinity` when empty. */
  ageMs: () => number;
}

export function createSceneCache(): SceneCache {
  let snapshot: SceneSnapshot | null = null;

  return {
    get: () => snapshot,
    set: (description, trigger) => {
      const trimmed = description.trim();
      if (!trimmed) return;
      snapshot = { description: trimmed, at: performance.now(), trigger };
    },
    ageMs: () => (snapshot ? performance.now() - snapshot.at : Infinity),
  };
}
