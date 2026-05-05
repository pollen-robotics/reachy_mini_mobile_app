/**
 * Local daemon discovery probe.
 *
 * Polls `http://127.0.0.1:8000/api/daemon/status` at a slow interval to
 * detect a daemon running on the same machine as the app (typical
 * desktop-dev setup or `reachy_mini_tray` USB session). This is the
 * **only** HTTP-to-daemon hop the mobile app makes, kept on purpose:
 * it's a read-only presence probe, not a command channel.
 *
 * Once we've established that a daemon is up, the actual connection
 * is still routed through HuggingFace central WebRTC signaling
 * (matched by `robot_name` in the central robot list) - i.e. the
 * "always go through central" rule for *commands* still holds.
 */
import { useEffect, useRef, useState } from 'react';

const PROBE_URL = 'http://127.0.0.1:8000/api/daemon/status';
const PROBE_INTERVAL_MS = 8_000;
const PROBE_TIMEOUT_MS = 1_500;

export interface LocalDaemonInfo {
  /** `robot_name` from the daemon (used to match a central peer entry). */
  robotName: string;
  /** `version` field if reported by the daemon. */
  version: string | null;
  /** `wlan_ip`: null when the daemon is USB-only (tray setup). */
  wlanIp: string | null;
  /**
   * `hardware_id` from the daemon - SHA-256 prefix of the Pollen audio
   * device's USB serial. Stable per physical robot across OS reinstalls
   * and renames. Same value the daemon advertises on BLE GATT
   * `HARDWARE_ID_UUID` and (post-PR-1084) on `meta.hardware_id` of its
   * central registration. The unified dedup key for the picker.
   *
   * `null` when the daemon runs on a developer machine with no Reachy
   * attached.
   */
  hardwareId: string | null;
}

export interface UseLocalDaemonProbeResult {
  /** `null` when no daemon is reachable; otherwise its identity. */
  info: LocalDaemonInfo | null;
  /** Whether the most recent probe is still in flight. */
  probing: boolean;
}

export function useLocalDaemonProbe(): UseLocalDaemonProbeResult {
  const [info, setInfo] = useState<LocalDaemonInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const inFlightRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;

    const probe = async (): Promise<void> => {
      // Drop any pending request before starting a new one.
      if (inFlightRef.current) {
        inFlightRef.current.abort();
      }
      const controller = new AbortController();
      inFlightRef.current = controller;
      const timeout = window.setTimeout(
        () => controller.abort(),
        PROBE_TIMEOUT_MS,
      );
      setProbing(true);
      try {
        const resp = await fetch(PROBE_URL, {
          method: 'GET',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
          // No credentials; no caching - this is a presence ping.
          cache: 'no-store',
        });
        if (cancelled) return;
        if (!resp.ok) {
          setInfo(null);
          return;
        }
        const data = (await resp.json()) as {
          robot_name?: string;
          version?: string;
          wlan_ip?: string | null;
          hardware_id?: string | null;
          state?: string;
        };
        if (cancelled) return;
        if (!data.robot_name) {
          setInfo(null);
          return;
        }
        setInfo({
          robotName: data.robot_name,
          version: typeof data.version === 'string' ? data.version : null,
          wlanIp: typeof data.wlan_ip === 'string' ? data.wlan_ip : null,
          hardwareId:
            typeof data.hardware_id === 'string' && data.hardware_id.length > 0
              ? data.hardware_id
              : null,
        });
      } catch {
        // Network error / timeout / abort - daemon not reachable.
        if (!cancelled) setInfo(null);
      } finally {
        if (!cancelled) setProbing(false);
        window.clearTimeout(timeout);
      }
    };

    void probe();
    const intervalId = window.setInterval(() => {
      void probe();
    }, PROBE_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      if (inFlightRef.current) inFlightRef.current.abort();
    };
  }, []);

  return { info, probing };
}
