/**
 * Put a robot on a Wi-Fi network over BLE, whether it's offline (first-time
 * setup) or already on another network (switching networks from the
 * Bluetooth tools / robot settings).
 *
 * Shared by the setup FSM (`useSetupMachine`) and the Bluetooth tools'
 * "Change Wi-Fi network" flow. Callers own the BLE link, the PIN session and
 * the `WIFI_KEYEX` payload; this module only sequences the protocol calls and
 * turns the daemon's polling surface into a single "joined, here's the IP" /
 * typed failure.
 *
 * Daemon behaviour this works around (`wifi_config.py`):
 *   - A SAVED network is brought up with its saved password: the password sent
 *     with the connect is ignored. To re-key one (password changed, typo saved
 *     earlier) it has to be forgotten first.
 *   - A failed join deletes the new profile and drops the robot to HOTSPOT,
 *     even when it was happily on another network before. Previously saved
 *     networks survive, so the caller can offer to rejoin the old one
 *     (empty password = use the saved one).
 */

import {
  connectSealed,
  forgetNetwork,
  readNetworkInfo,
  scanWifi,
  wifiStatus,
} from './protocol';

export const WIFI_POLL_INTERVAL_MS = 2_500;
export const WIFI_POLL_TIMEOUT_MS = 75_000;
/** Budget for the daemon to delete a saved profile before we re-create it. */
const FORGET_TIMEOUT_MS = 15_000;
/** NETWORK_STATUS (cdef4) refreshes on a ~10 s tick: an IP read sooner than
 *  this after the join may still be the one from the previous network. */
const NET_STATUS_REFRESH_MS = 12_000;

/** True once the caller moved on (unmount, new run): helpers bail out quietly. */
export type IsStale = () => boolean;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * `WIFI_SCAN` with retries. The daemon's first scan right after it leaves
 * hotspot mode usually comes back EMPTY (`nmcli rescan` is async and the cache
 * is read immediately), and a concurrent rescan replies "busy". Retry a few
 * times so the user never sees a spuriously empty list.
 */
export async function scanWifiResilient(
  isStale: IsStale,
  { attempts = 3, retryDelayMs = 1_800 } = {},
): Promise<string[]> {
  let found: string[] = [];
  for (let i = 0; i < attempts; i++) {
    try {
      found = await scanWifi();
    } catch (e) {
      // A transient "busy" is worth retrying; any other error - or busy on
      // the last attempt - propagates.
      if (i === attempts - 1 || !/busy/i.test((e as Error).message ?? '')) throw e;
    }
    if (isStale() || found.length > 0) return found;
    if (i < attempts - 1) await sleep(retryDelayMs);
    if (isStale()) return found;
  }
  return found;
}

/** A join the robot reported as failed, or never finished. */
export class WifiJoinError extends Error {
  constructor(
    readonly code: 'wrong-password' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'WifiJoinError';
  }
}

export interface JoinNetworkOptions {
  ssid: string;
  /** Empty = join a SAVED network with the password the robot already has. */
  password: string;
  pin: string;
  /** Raw `WIFI_KEYEX` reply (sealing key). */
  keyex: string;
  /** Networks saved on the robot (`WifiStatus.known`, authed sessions only). */
  known?: string[];
  isStale: IsStale;
  /** Runs once the daemon accepted the request, before polling (the wizard
   *  cues its "waiting" move here). Must stay on the BLE chain: awaited. */
  onAccepted?: () => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  netStatusRefreshMs?: number;
}

/**
 * Join `ssid` and wait until the robot is really on it with a LAN IP.
 *
 * Resolves the robot's new IP, or `null` when `isStale()` flipped meanwhile.
 * Throws a {@link WifiJoinError} when the robot refused the network (the
 * daemon reverts to hotspot) or didn't make it in time; any other error is a
 * transport / daemon error to map with `toSetupError`.
 */
export async function joinNetwork(opts: JoinNetworkOptions): Promise<string | null> {
  const {
    ssid,
    password,
    pin,
    keyex,
    known = [],
    isStale,
    onAccepted,
    timeoutMs = WIFI_POLL_TIMEOUT_MS,
    pollIntervalMs = WIFI_POLL_INTERVAL_MS,
    netStatusRefreshMs = NET_STATUS_REFRESH_MS,
  } = opts;

  // A new password for a saved network: drop the stale profile first, or the
  // daemon would bring it up with the OLD password and ignore this one.
  if (password && known.includes(ssid)) {
    await forgetNetwork(ssid);
    const forgotten = await waitUntilForgotten(ssid, isStale, pollIntervalMs);
    if (forgotten === null) return null;
  }

  // Where the robot is before the join: when switching networks, its old IP
  // lingers in NETWORK_STATUS for a tick and must not be read as the new one.
  const before = await readNetworkInfo().catch(() => null);
  if (isStale()) return null;

  await connectSealed(ssid, password, pin, keyex);
  if (isStale()) return null;
  if (onAccepted) await onAccepted();
  if (isStale()) return null;

  // WIFI_STATUS names the network as soon as NetworkManager STARTS joining
  // it (wrong password included), so the name alone is not "joined". The
  // daemon reports `busy` until the join returned; past that, wait for
  // NETWORK_STATUS to report a LAN IP. If that IP is the one the robot had
  // before (switching networks), only trust it once the characteristic has
  // refreshed: a same-router switch often keeps the same DHCP lease.
  const deadline = Date.now() + timeoutMs;
  const hadIp = before?.mode === 'connected' ? before.ip : null;
  let settledAt: number | null = null;
  for (;;) {
    await sleep(pollIntervalMs);
    if (isStale()) return null;
    const status = await wifiStatus();
    if (isStale()) return null;
    if (status.error) {
      throw new WifiJoinError('wrong-password', 'Could not join the network. The password may be wrong.');
    }
    if (status.connected === ssid && status.mode !== 'busy') {
      settledAt ??= Date.now();
      const net = await readNetworkInfo().catch(() => null); // retried next tick
      if (isStale()) return null;
      const fresh = net?.ip !== hadIp || Date.now() - settledAt >= netStatusRefreshMs;
      if (net?.mode === 'connected' && net.ip && fresh) return net.ip;
    }
    if (Date.now() > deadline) {
      throw new WifiJoinError('timeout', "The robot didn't join the network in time. Try again.");
    }
  }
}

/** Poll until `ssid` left the saved list and the daemon is idle again.
 *  `true` once done, `null` when stale. Gives up silently at the deadline:
 *  the connect that follows reports a still-busy daemon on its own. */
async function waitUntilForgotten(
  ssid: string,
  isStale: IsStale,
  pollIntervalMs: number,
): Promise<true | null> {
  const deadline = Date.now() + FORGET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, 1_000));
    if (isStale()) return null;
    const status = await wifiStatus().catch(() => null);
    if (isStale()) return null;
    if (status && status.mode !== 'busy' && !(status.known ?? []).includes(ssid)) return true;
  }
  return true;
}
