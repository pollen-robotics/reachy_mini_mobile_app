/**
 * Direct Hugging Face central signaling server access, no daemon
 * proxy needed.
 *
 * Used for both fleet discovery and per-robot peer-id lookup
 * ──────────────────────────────────────────────────────────
 * In remote mode the phone has no LAN line of sight to anyone. The
 * user opens the app from another city, on cellular, and we still
 * need to:
 *   1. Know which robots they own (the card list).
 *   2. Get each robot's central peerId so we can `startSession()`.
 *
 * In LAN mode the same call is reused (via `useResolvedPeerId`) to
 * resolve the peer id of the BLE-discovered robot, since the BLE
 * advertisement does not carry the central id and the daemon proxy
 * cannot answer it (the proxy needs an open WebRTC, which itself
 * needs the peer id - chicken-and-egg).
 *
 * The token is held on the phone (memory + localStorage); central
 * enforces per-user scoping so we can only see our own fleet. The
 * trust boundary stays at "whoever owns the token controls the
 * robot".
 */

const CENTRAL_ROBOT_STATUS_URL =
  'https://cduss-reachy-mini-central.hf.space/api/robot-status';

const CENTRAL_REQUEST_TIMEOUT_MS = 8_000;

export interface CentralRobotEntry {
  // Central's wire format is loose: id / peerId / peer_id have all
  // appeared across versions of the relay. Read whichever is
  // present rather than locking in one schema.
  id?: string;
  peerId?: string;
  peer_id?: string;
  /**
   * Producer metadata forwarded verbatim by the daemon's
   * `setPeerStatus`. `install_id` is the stable per-install
   * reconciliation key (same value also appears on this robot's
   * mDNS TXT record / loopback `/api/daemon/identity` / BLE GATT)
   * and is what the mobile robot registry merges on. `name` is the
   * human-readable label.
   *
   * NOTE (2026-04): the current `cduss/reachy-mini-central` server
   * extracts `meta.name` into the top-level `robotName` field below
   * but does NOT propagate `meta.install_id`. Until the server is
   * updated to forward the full meta blob, central listings cannot
   * be dedupe-merged with the loopback daemon - we still keep the
   * field defined so the client is forward-compatible with the
   * upcoming central change.
   */
  meta?: { name?: string; install_id?: string };
  name?: string;
  /** Top-level field actually returned by the current central API. */
  robotName?: string;
}

export interface RemoteRobotsResult {
  ok: boolean;
  /** Robots the authenticated user owns, regardless of in-use state. */
  robots: CentralRobotEntry[];
  /**
   * Diagnostic message when `ok === false`. Suitable for showing
   * to the user verbatim ("Token rejected", "Couldn't reach Hugging
   * Face", etc.).
   */
  reason?: string;
  /**
   * Raw JSON central returned, kept verbatim for the diagnostics
   * panel. Helpful when the list looks empty: central might be
   * returning `{ robots: [] }` (no robots online) or unexpected
   * keys we'd otherwise silently drop on the floor.
   */
  raw?: unknown;
}

/**
 * Coerce any of central's id field shapes into the canonical string
 * the SDK consumes via `robot.startSession(id)`.
 */
export function extractRobotId(entry: CentralRobotEntry | undefined): string | null {
  if (!entry) return null;
  const raw = entry.id ?? entry.peerId ?? entry.peer_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Best-effort name for the UI. Read order matches the precedence we
 * want to honour as the central server schema evolves:
 *   1. `meta.name` - what the daemon emits on `setPeerStatus`. Will
 *      be the source of truth once the central server propagates the
 *      full `meta` blob (see CentralRobotEntry comment).
 *   2. `robotName` - what the current central server returns at the
 *      top level (extracted server-side from `meta.name`).
 *   3. `name` - older central versions used this top-level shape.
 *   4. peer id slice - last resort so we still render something
 *      printable instead of `undefined`.
 */
export function extractRobotName(entry: CentralRobotEntry | undefined): string {
  if (!entry) return 'Unknown robot';
  return (
    entry.meta?.name ??
    entry.robotName ??
    entry.name ??
    extractRobotId(entry) ??
    'Unknown robot'
  );
}

/**
 * Stable per-install reconciliation key. Returns `null` when the
 * central record does not carry one (older daemons that pre-date
 * api_revision 3, or third-party producers). Callers MUST treat
 * `null` as "uniquely identified by central peerId only" and fall
 * back to peerId-based dedupe.
 */
export function extractInstallId(
  entry: CentralRobotEntry | undefined,
): string | null {
  const raw = entry?.meta?.install_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export async function fetchRobotsFromCentral(
  hfToken: string,
): Promise<RemoteRobotsResult> {
  if (!hfToken) {
    return { ok: false, robots: [], reason: 'No HF token provided' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CENTRAL_REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(CENTRAL_ROBOT_STATUS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${hfToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, robots: [], reason: 'Token rejected by Hugging Face' };
    }
    if (!resp.ok) {
      return {
        ok: false,
        robots: [],
        reason: `Central returned HTTP ${resp.status}`,
      };
    }

    const data = (await resp.json()) as { robots?: CentralRobotEntry[] };
    const robots = Array.isArray(data.robots) ? data.robots : [];
    // Surface the raw payload at debug-info level so devs can spot
    // unexpected schema (e.g. central renaming `robots` to `peers`)
    // without flipping a flag — keeping it on `info` keeps it out
    // of the way during normal operation since most browsers fold
    // info logs by default.
    console.info('[remote] central /api/robot-status', data);
    return { ok: true, robots, raw: data };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, robots: [], reason: 'Hugging Face central timed out' };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, robots: [], reason: `Network error: ${message}` };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validate a HF token against the user-info endpoint. Cheap pre-flight
 * before bothering with the central. Returns the username on success
 * so the UI can show "Connected as <user>".
 */
export interface HfWhoami {
  ok: boolean;
  username?: string;
  reason?: string;
}

export async function validateHfToken(token: string): Promise<HfWhoami> {
  if (!token) return { ok: false, reason: 'Empty token' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CENTRAL_REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch('https://huggingface.co/api/whoami-v2', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, reason: 'Token rejected by Hugging Face' };
    }
    if (!resp.ok) {
      return { ok: false, reason: `HF whoami HTTP ${resp.status}` };
    }
    const data = (await resp.json()) as { name?: string; fullname?: string };
    return { ok: true, username: data.name ?? data.fullname };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, reason: 'Hugging Face timed out' };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Network error: ${message}` };
  } finally {
    clearTimeout(timeout);
  }
}
