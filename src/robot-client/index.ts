/**
 * Public surface of the `robot-client` module.
 *
 * Exports:
 *   - `RobotClient`, `RobotFetchOptions`, `RobotResponse`: the
 *     unified types call sites should use instead of importing from
 *     `daemon/daemonFetch` directly.
 *   - `createRobotClient(...)`: factory that picks LAN HTTP or
 *     WebRTC `http_proxy` based on the connection mode.
 *   - `setActiveDataChannel`, `subscribeDataChannel`,
 *     `getActiveDataChannel`: registry hooks used by `useReachySdk`
 *     to plug the SDK's DataChannel into the WebRTC transport.
 *
 * Migration path
 * ──────────────
 * Existing code calls `daemonFetch(host, path, opts)` and assumes
 * the LAN HTTP transport. To migrate one call site at a time:
 *
 *   1. Build a client at the right scope: usually inside a hook
 *      that knows whether we're in LAN or remote mode.
 *      `const client = createRobotClient({daemonHost, remoteMode})`
 *   2. Replace `daemonFetch(host, path, opts)` with
 *      `client.fetch(path, opts)`. The response shape is identical.
 *   3. Forward `client` to children that need to make daemon calls,
 *      or stash it in a context so the whole subtree is transparent
 *      to LAN-vs-remote.
 *
 * `daemonFetch` itself stays where it is - the LAN client uses it
 * internally - so call sites that aren't migrated yet keep working.
 */
export type {
  RobotClient,
  RobotFetchOptions,
  RobotResponse,
} from './types';
export {
  getActiveDataChannel,
  setActiveDataChannel,
  subscribeDataChannel,
} from './dataChannelRegistry';

import { createLocalHttpClient } from './localHttpClient';
import { createWebRtcClient } from './webrtcClient';
import type { RobotClient } from './types';

export interface RobotClientFactoryOptions {
  /**
   * Daemon host (IP or hostname, no scheme/port) when reachable on
   * the LAN. Required in LAN mode, ignored in remote mode.
   */
  daemonHost: string | null;
  /**
   * `true` when the phone has no LAN line of sight to the daemon
   * and uses central signaling. The factory then returns a WebRTC
   * client that tunnels every call through the SDK's DataChannel.
   */
  remoteMode: boolean;
}

/**
 * Build a transport-appropriate `RobotClient`.
 *
 * - LAN mode (`remoteMode=false`, `daemonHost` set): direct HTTP via
 *   Tauri's `daemon_fetch` shim. Lowest overhead, works offline of
 *   the internet.
 * - Remote mode (`remoteMode=true`): every call is wrapped in an
 *   `http_proxy` command and sent on the WebRTC DataChannel that the
 *   conversation engine (or anything else hosting a `ReachyMini`
 *   instance) has opened. If the DC is not yet open, calls return
 *   a synthetic `{status: 0, rawBody: 'no active webrtc data
 *   channel'}` so callers can render a "connecting…" state without
 *   special-casing the transport.
 *
 * Edge case: a missing `daemonHost` in LAN mode is a programmer bug
 * (the host should already have been resolved by discovery); we fail
 * predictably by returning a WebRTC client. The call will end up
 * with `no active …` until the SDK comes up, surfaced as a clean
 * error in the UI rather than a thrown exception in render code.
 */
export function createRobotClient(
  opts: RobotClientFactoryOptions,
): RobotClient {
  if (opts.remoteMode) return createWebRtcClient();
  if (!opts.daemonHost) return createWebRtcClient();
  return createLocalHttpClient(opts.daemonHost);
}
