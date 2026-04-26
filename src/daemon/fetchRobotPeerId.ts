/**
 * Ask the daemon for the id the robot registered as on the
 * Hugging Face central signaling server.
 *
 * Why we need this at all
 * ───────────────────────
 * The ReachyMini JS SDK's public flow is:
 *
 *   robot.connect()              // SSE to central.hf.space
 *   → wait "robotsChanged" event // central pushes the user's robots
 *   → pick a robotId             // here we auto-pick the first one
 *   → robot.startSession(robotId)
 *
 * On mobile this stalls on "Waiting for Reachy" because the
 * robotsChanged event can take several seconds to fire (central-side
 * relay re-auth, SSE buffering, etc.) - or sometimes never fires at
 * all if the daemon's own relay to central hasn't finished
 * reconnecting with the freshly stored HF token.
 *
 * But we don't actually need the event: the mobile app already
 * talked to *this specific* robot over Bluetooth and HTTP, so we
 * know which robot the user wants. The daemon can tell us the peer
 * id that robot is registered as on central (by proxying central's
 * own `/api/robot-status`), and the SDK's `startSession(id)` works
 * without requiring the id to appear in `robot.robots` first.
 *
 * Happy path
 * ──────────
 *   GET http://<daemon>:8000/api/hf-auth/central-robot-status
 *     → { available: true, robots: [{ id, meta?, ... }, ...] }
 *   → we return `robots[0].id`
 *
 * The user might own multiple Reachy Minis on the same HF account;
 * the mobile app is paired to only one at a time via BLE, so picking
 * `robots[0]` is an imperfect heuristic. For now it's safe because:
 *   - the daemon itself is the one answering; any robot registered
 *     from a different Reachy is on a different daemon, on a
 *     different IP, that we're not even talking to.
 *   - central's `/api/robot-status` returns only the robots owned by
 *     the authenticated user, so there's no privilege escalation if
 *     we end up with the wrong peer id (startSession would just fail
 *     cleanly and the engine would fall back to waiting on
 *     robotsChanged).
 *
 * Degraded paths we swallow
 * ─────────────────────────
 *   - HTTP 4xx / 5xx / network error → resolve to `null`, caller
 *     falls back to the normal wait-for-robotsChanged flow.
 *   - `available: false` (no HF token, central unreachable, token
 *     rejected) → also `null`.
 *   - `robots: []` (relay not registered yet) → also `null`; the
 *     engine will use its "Waiting for Reachy" state as a fallback
 *     so the user isn't left with a silent no-op.
 *
 * We never throw from here: the preselected-id optimisation is
 * strictly a shortcut, and a failure to grab the id must not prevent
 * the normal flow.
 */

import { daemonFetch } from './daemonFetch';

interface CentralRobotEntry {
  // Central's wire format is a bit loose - we've seen `id`, `peerId`
  // and `peer_id` in different versions of the relay, so we read
  // whatever's there rather than locking in one schema.
  id?: string;
  peerId?: string;
  peer_id?: string;
  meta?: { name?: string };
  name?: string;
}

interface CentralRobotStatusPayload {
  available: boolean;
  robots?: CentralRobotEntry[];
  reason?: string;
}

function extractId(entry: CentralRobotEntry | undefined): string | null {
  if (!entry) return null;
  const raw = entry.id ?? entry.peerId ?? entry.peer_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export async function fetchRobotPeerId(host: string): Promise<string | null> {
  try {
    const resp = await daemonFetch<CentralRobotStatusPayload>(
      host,
      '/api/hf-auth/central-robot-status',
      { timeoutMs: 5_000 }
    );
    if (!resp.ok) {
      console.warn(
        `[fetchRobotPeerId] daemon replied ${resp.status}: ${resp.rawBody}`
      );
      return null;
    }
    const data = resp.data;
    if (!data?.available) {
      console.info(
        `[fetchRobotPeerId] central not available (reason=${data?.reason ?? 'unknown'})`
      );
      return null;
    }
    const robots = Array.isArray(data.robots) ? data.robots : [];
    if (!robots.length) {
      console.info('[fetchRobotPeerId] central returned empty robot list');
      return null;
    }
    const id = extractId(robots[0]);
    if (!id) {
      console.warn(
        '[fetchRobotPeerId] first robot has no usable id field:',
        robots[0]
      );
      return null;
    }
    return id;
  } catch (err) {
    console.warn('[fetchRobotPeerId] failed:', err);
    return null;
  }
}
