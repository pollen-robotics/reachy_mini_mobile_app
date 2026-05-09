/**
 * Direct Hugging Face central signaling server access, no daemon
 * proxy needed.
 *
 * Why this exists alongside `fetchRobotPeerId`
 * ────────────────────────────────────────────
 * `fetchRobotPeerId` is the LAN happy path: the phone is on the
 * same Wi-Fi as the robot, BLE has just told us its IP, and we ask
 * THAT specific daemon "what id are you registered as on central?".
 * The daemon proxies to central and never lets the raw HF token
 * leave the device.
 *
 * Remote mode (this file) is the inverse: the phone has no LAN
 * line of sight to any robot. The user opens the app from another
 * city, on cellular, and we still need to:
 *   1. Know which robot to talk to.
 *   2. Get its central peerId so we can `startSession()`.
 *
 * Both pieces are answered by the same endpoint we already proxy
 * (`/api/robot-status`), only this time we hit central directly
 * with the user-provided HF token. The token is held in memory /
 * localStorage on the phone; central never sees a daemon proxy.
 *
 * Security note: this is no worse than what `daemon/fetchRobotPeerId`
 * already does — central enforces that a user can only see their
 * own robots, so we cannot accidentally enumerate someone else's
 * fleet. The HF token simply moves from the daemon's keyring to
 * the phone's localStorage; the trust boundary stays at "whoever
 * owns the token controls the robot".
 */

import { CENTRAL_SIGNALING_URL } from '@/shared/env';

const CENTRAL_ROBOT_STATUS_URL = `${CENTRAL_SIGNALING_URL}/api/robot-status`;

const CENTRAL_REQUEST_TIMEOUT_MS = 8_000;

/**
 * How a client physically reaches the daemon backing this listing.
 * Matches the daemon's `meta.transport` advertised on `setPeerStatus`
 * (see `_build_producer_meta` in `central_signaling_relay.py`).
 *
 * - `"usb"`  - desktop-tray daemon, robot tethered to the user's
 *              machine over USB (loopback HTTP available too).
 * - `"wifi"` - autonomous daemon (Wireless variant or Lite on its own
 *              Pi), reached over Wi-Fi / LAN.
 *
 * Pre-feature daemons don't emit this field; consumers MUST treat
 * `undefined` as `"wifi"` (the autonomous case is the broad default).
 * The shape is intentionally a free-form string to leave room for
 * `"ethernet"`, `"sim"`, `"mockup"`, ... without a wire schema bump.
 */
export type RobotTransport = string;

export interface CentralRobotEntry {
  // Central's wire format is loose: id / peerId / peer_id have all
  // appeared across versions of the relay. Read whichever is
  // present rather than locking in one schema.
  id?: string;
  peerId?: string;
  peer_id?: string;
  /**
   * Wall-clock seconds since central last received a heartbeat from
   * this producer (POST /send setPeerStatus). Used by the WiFi setup
   * verifying phase to confirm a freshly-joined robot is actually
   * online (a young value, < ~30 s) vs. about to be swept by the TTL
   * sweeper. Older centrals don't emit this field.
   */
  last_seen_age_seconds?: number;
  meta?: {
    name?: string;
    transport?: RobotTransport;
    /**
     * Typed flag set by the daemon when running in MuJoCo-sim or
     * mockup-sim mode. Redundant with `transport === 'simulation'`
     * but emitted as a real boolean so a strict client can branch
     * without string parsing. Older daemons don't emit this field;
     * consumers that care about pre-update daemons should also
     * accept `transport === 'simulation'` as a signal.
     */
    simulation?: boolean;
    /**
     * `meta.hardware_id` (post-PR-1084): SHA-256 prefix of the Pollen
     * audio device's USB serial. Stable per physical robot, identical
     * to what the daemon advertises on BLE GATT and exposes via
     * `GET /api/daemon/hardware-id`. Absent when the daemon has no
     * Reachy attached, or when the daemon is older than PR-1084.
     */
    hardware_id?: string;
  };
  name?: string;
}

/**
 * Resolve the transport this entry advertises, with a `"wifi"` fallback
 * for pre-feature daemons. UI consumers branch on the return value.
 */
export function extractRobotTransport(
  entry: CentralRobotEntry | undefined,
): RobotTransport {
  const raw = entry?.meta?.transport;
  return typeof raw === 'string' && raw.length > 0 ? raw : 'wifi';
}

/**
 * Pull the stable hardware id out of a central listing entry, or
 * return `null` if the daemon is too old (pre-PR-1084) or runs
 * without a Reachy attached. Callers fall back to `peerId` for
 * display when this returns `null` - the bare `peerId` is unstable
 * (rotates on every relay reconnect) but it's the only id we have
 * left.
 */
export function extractRobotHardwareId(
  entry: CentralRobotEntry | undefined,
): string | null {
  const raw = entry?.meta?.hardware_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Whether this listing represents a virtual (simulated) robot.
 *
 * Two signals, in priority order:
 *   1. `meta.simulation === true` (typed boolean, post-update daemons).
 *   2. `meta.transport === 'simulation'` (string fallback for the
 *      first iteration of the feature, or for non-bool consumers).
 *
 * Returns `false` for daemons that don't advertise either - which
 * is the correct default for any real robot.
 */
export function extractRobotSimulation(
  entry: CentralRobotEntry | undefined,
): boolean {
  if (entry?.meta?.simulation === true) return true;
  return entry?.meta?.transport === 'simulation';
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
 * Best-effort name for the UI: `meta.name` (set by the daemon when
 * the relay registers as a producer) → top-level `name` → falls
 * back to the id so we always have something printable.
 */
export function extractRobotName(entry: CentralRobotEntry | undefined): string {
  if (!entry) return 'Unknown robot';
  return entry.meta?.name ?? entry.name ?? extractRobotId(entry) ?? 'Unknown robot';
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
