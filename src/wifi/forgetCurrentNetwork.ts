/**
 * Transport-agnostic "forget current Wi-Fi" flow.
 *
 * The old `ForgetWifiDialog` drove a BLE-only choreography (PIN over
 * BLE → `WIFI_STATUS` over BLE → `WIFI_FORGET ssid` over BLE) that
 * tied the feature to local pairings. Once the user is on a remote
 * session there is no BLE link, so the dialog used to be hidden
 * entirely.
 *
 * This module routes the same intent through `RobotClient` instead.
 * The daemon already exposes the equivalent HTTP endpoints
 * (`GET /api/wifi/status` + `POST /api/wifi/forget?ssid=...`) and
 * `RobotClient` decides whether the bytes flow over LAN HTTP or the
 * WebRTC `http_proxy` data channel. The feature is therefore
 * available at parity for both transports.
 *
 * Why no PIN gate
 * ───────────────
 * The PIN existed only to authenticate privileged BLE commands; the
 * HTTP surface itself is unauthenticated by design (the LAN /
 * WebRTC trust boundary is enforced one level up: BLE pairing or HF
 * central session). Adding a PIN here would be theatre. The dialog
 * still shows a confirmation step so the user can't trigger the
 * action by mistake.
 */
import type { RobotClient } from '../robot-client/types';

import { createLogger } from '../logger';

const logger = createLogger('wifi.forget');

interface WifiStatusResponse {
  mode: 'wlan' | 'hotspot' | 'busy' | 'disconnected';
  /**
   * Daemon name for the active connection, falls back to `null` when
   * not on Wi-Fi. We treat `"Hotspot"` (case-insensitive) as
   * "no real network" because forgetting the hotspot would brick the
   * fallback path.
   */
  connected_network?: string | null;
  known_networks?: string[];
}

export interface ForgetCurrentResult {
  ok: boolean;
  /** SSID we asked the daemon to forget, when we found one. */
  forgottenSsid: string | null;
  /** Stable error code so the UI doesn't substring-match free text. */
  error?:
    | 'no-active-network'
    | 'status-failed'
    | 'forget-failed'
    | 'transport-error';
  /** Human-friendly diagnostic for surface in the dialog footer. */
  errorMessage?: string;
}

/**
 * Read the active SSID, then ask the daemon to forget it. Both calls
 * go through the same `RobotClient`, so the operation works
 * identically over LAN and over the WebRTC proxy.
 */
export async function forgetCurrentNetwork(
  client: RobotClient,
): Promise<ForgetCurrentResult> {
  logger.info('start', { transport: client.transport });

  // Step 1: read current SSID via /api/wifi/status.
  let status: WifiStatusResponse;
  try {
    const resp = await client.fetch<WifiStatusResponse>('/api/wifi/status', {
      method: 'GET',
      timeoutMs: 6_000,
    });
    if (!resp.ok || !resp.data) {
      logger.warn('status.failed', { http_status: resp.status });
      return {
        ok: false,
        forgottenSsid: null,
        error: 'status-failed',
        errorMessage: `Couldn't read the robot's network status (HTTP ${resp.status}).`,
      };
    }
    status = resp.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('status.transport_error', { message });
    return {
      ok: false,
      forgottenSsid: null,
      error: 'transport-error',
      errorMessage: message,
    };
  }

  const ssid = (status.connected_network ?? '').trim();
  if (!ssid || ssid.toLowerCase() === 'hotspot' || status.mode !== 'wlan') {
    logger.info('no_active_network', {
      mode: status.mode,
      connected: status.connected_network ?? null,
    });
    return {
      ok: false,
      forgottenSsid: null,
      error: 'no-active-network',
      errorMessage: "The robot isn't on a Wi-Fi network right now.",
    };
  }

  // Step 2: forget it. The daemon flips back to hotspot on success
  // (handled server-side in `wifi_config.py:forget`).
  try {
    const path = `/api/wifi/forget?ssid=${encodeURIComponent(ssid)}`;
    const resp = await client.fetch(path, { method: 'POST', timeoutMs: 8_000 });
    if (!resp.ok) {
      logger.warn('forget.failed', { http_status: resp.status, ssid });
      return {
        ok: false,
        forgottenSsid: ssid,
        error: 'forget-failed',
        errorMessage: `Daemon refused to forget the network (HTTP ${resp.status}).`,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('forget.transport_error', { ssid, message });
    return {
      ok: false,
      forgottenSsid: ssid,
      error: 'transport-error',
      errorMessage: message,
    };
  }

  logger.info('success', { ssid });
  return { ok: true, forgottenSsid: ssid };
}
