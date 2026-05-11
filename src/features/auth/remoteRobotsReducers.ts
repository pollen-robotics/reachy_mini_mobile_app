/**
 * Pure reducers for the `useRemoteRobots` cache.
 *
 * Extracted out of the hook so they can be unit-tested without
 * spinning up a `QueryClient`, an SSE mock, or a React tree. The
 * hook in `useRemoteRobots.ts` wires them into `setQueryData`
 * callbacks; everything else (event parsing, reconnect, throttle)
 * lives upstream of these functions.
 *
 * Identity convention
 * ───────────────────
 * Central's wire format is loose: the same row can carry `id`,
 * `peerId`, or `peer_id` depending on the relay version. We
 * normalise to the first non-empty value, mirroring
 * `extractRobotId()`. Keep this in sync if that helper grows new
 * fallbacks - the reducers can't import it without a circular
 * dependency on the type module, so the lookup is duplicated here.
 */
import type { CentralRobotEntry } from './fetchRobotsFromCentral';

function rowId(row: CentralRobotEntry): string | null {
  return row.id ?? row.peerId ?? row.peer_id ?? null;
}

/**
 * Patch `busy` / `activeApp` on the matching row, returning a new
 * array. Returns the input untouched when:
 *
 *   - the input is undefined (cache slot empty - first SSE event
 *     beat the REST query, fine, it'll catch up on the next tick),
 *   - no row matches the peerId (push for a robot that we don't
 *     yet have in our list - the next REST poll / on-reconnect
 *     refetch will hydrate it).
 *
 * Returning the same reference (rather than a fresh array) when
 * nothing changed is what TanStack Query relies on to short-circuit
 * the React render: identity-stable cache values don't trigger a
 * re-render of the consumer.
 */
export function patchBusyState(
  robots: CentralRobotEntry[] | undefined,
  peerId: string,
  busy: boolean,
  activeApp: string | null,
): CentralRobotEntry[] | undefined {
  if (!robots) return robots;
  let touched = false;
  const next = robots.map(r => {
    if (rowId(r) !== peerId) return r;
    touched = true;
    return { ...r, busy, activeApp };
  });
  return touched ? next : robots;
}

/**
 * Remove a producer from the cached list. Used on
 * `peerStatusChanged{roles: []}` (the producer withdrew or was
 * disconnected). Same identity-stable contract as
 * `patchBusyState`: returns the same reference when the peerId
 * was not present.
 */
export function dropProducer(
  robots: CentralRobotEntry[] | undefined,
  peerId: string,
): CentralRobotEntry[] | undefined {
  if (!robots) return robots;
  const next = robots.filter(r => rowId(r) !== peerId);
  return next.length === robots.length ? robots : next;
}
