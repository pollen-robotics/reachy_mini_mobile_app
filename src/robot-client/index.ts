/**
 * Public surface of the `robot-client` module.
 *
 * Single transport
 * ────────────────
 * Every daemon API call goes through WebRTC's `http_proxy` command on
 * the SDK's DataChannel, regardless of whether the user got here over
 * Bluetooth (BLE list, same Wi-Fi as the robot) or over Hugging Face
 * central signaling (anywhere in the world). The "prefer LAN when
 * available" intent is delegated to ICE: when both peers are on the
 * same subnet, ICE picks the host candidate and the same WebRTC
 * session is effectively a P2P LAN tunnel, with a TURN/relay fallback
 * otherwise.
 *
 * Why one transport instead of two
 * ────────────────────────────────
 * The previous design forked between `localHttpClient` (LAN HTTP via
 * Tauri's `daemon_fetch`) and `webrtcClient` based on a `remoteMode`
 * flag the UI set on robot pickup. That meant:
 *
 *   - The same daemon endpoint had two code paths to reason about
 *     (auth, timeouts, error shapes), with subtle drift between them.
 *   - LAN-discovered robots that were reachable BOTH over BLE and
 *     central could end up on either path depending on which list the
 *     user tapped, with no fallback if the chosen path was unhealthy.
 *   - Every screen had to thread `daemonHost` through `useMemo`s.
 *
 * Centralising on WebRTC removes all of that: the screen instantiates
 * a single client at mount, ICE figures out the best route, and a
 * stale relay path heals via the existing `useDaemonRelayHealing`
 * code path instead of dual-path branching.
 *
 * Exports
 * ───────
 *   - `RobotClient`, `RobotFetchOptions`, `RobotResponse`: unified
 *     types call sites should use instead of importing from
 *     `daemon/daemonFetch` directly.
 *   - `createRobotClient()`: factory that returns a WebRTC-backed
 *     client. Kept as a factory (instead of just exporting the
 *     instance) so call sites remain explicit about lifecycle and so
 *     we can reintroduce per-screen options later without churn.
 *   - `setActiveDataChannel`, `subscribeDataChannel`,
 *     `getActiveDataChannel`: registry hooks used by `useReachySdk`
 *     to plug the SDK's DataChannel into the WebRTC transport.
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

import { createWebRtcClient } from './webrtcClient';
import type { RobotClient } from './types';

/**
 * Build a `RobotClient` that tunnels every daemon HTTP call through
 * the WebRTC DataChannel hosted by the conversation engine.
 *
 * Concurrency / lifecycle:
 *   - The DC must be open for `client.fetch()` to succeed; calls made
 *     before the SDK has negotiated it return a synthetic
 *     `{status: 0, rawBody: 'no active webrtc data channel'}` so
 *     callers can show a "connecting…" UI without special-casing the
 *     transport.
 *   - The factory is cheap (no I/O), so it's fine to call it inside
 *     a `useMemo([])` at screen mount. The same instance can serve
 *     the entire screen even if the DC underneath gets replaced - the
 *     registry handles that transparently.
 */
export function createRobotClient(): RobotClient {
  return createWebRtcClient();
}
