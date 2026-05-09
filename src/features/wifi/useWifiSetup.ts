/**
 * WiFi provisioning hook layered on top of the persistent BLE session.
 *
 * The session hook (`useBleSession`) owns the BLE connection lifecycle.
 * This hook stays focused on the WiFi state machine:
 *
 *   * First-time flow: PIN -> scan SSIDs -> connect -> verify.
 *   * Change-network flow: PIN -> forget current SSID (or just connect
 *     to a new one) -> verify.
 *   * Status polling runs only while the session is connected. Polls
 *     are FIFO-queued by the session's command mutex, so we never
 *     interleave a poll with a user-initiated write.
 *
 * Auth state is intentionally local: the daemon keeps `self.connected`
 * alive across BLE sessions, so once `authenticate()` succeeds, every
 * subsequent `WIFI_*` call on this device works, even if the BLE link
 * drops and is re-opened.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { BleWifiStatus, WifiProbeResult } from '@/types/robot';
import { formatBlecError, useBleSession } from '@/features/ble/useBleSession';

const STATUS_POLL_MS = 3_000;
const FAST_POLL_MS = 1_500;
/**
 * How long we keep fast-polling after a connect / forget attempt. The
 * daemon normally flips to `mode=wlan` within 10-15 s on a happy-path
 * connect, and falls back to `mode=hotspot` after a similar delay on
 * failure.
 */
const FAST_POLL_DURATION_MS = 30_000;

/** WIFI_SCAN blocks the daemon BT loop for up to ~10 s (nmcli rescan). */
const WIFI_SCAN_READ_DELAY_MS = 1_000;

/**
 * Daemon-side budget for `WIFI_PROBE` is ~2.5 s + a 1 s individual
 * cap; we wait one extra second on the BLE round-trip before
 * reading back the response characteristic. Anything past that is
 * almost certainly a stalled DBus loop, not a slow probe.
 */
const WIFI_PROBE_READ_DELAY_MS = 3_500;

type IntervalHandle = ReturnType<typeof setInterval>;
type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface UseWifiSetupResult {
  status: BleWifiStatus | null;
  isAuthenticated: boolean;
  scanResults: string[];
  isBusy: boolean;
  error: string | null;

  authenticate: (pin: string) => Promise<boolean>;
  scan: () => Promise<string[]>;
  connect: (ssid: string, psk: string) => Promise<boolean>;
  /** Tell the robot to drop the given SSID. Optionally disconnects our
   * BLE session right after (true by default) so the user can restart
   * a clean find-robot + connect cycle. */
  forget: (ssid: string, options?: { disconnectAfter?: boolean }) => Promise<boolean>;
  refresh: () => Promise<void>;
  /** One-shot read of the public `WIFI_STATUS` BLE command (no auth
   * required), bypassing the periodic poller's React-state cycle.
   * Useful in synchronous routing decisions where we need the
   * authoritative value right now (e.g. on connect, deciding
   * `already-online` vs `pin` flow without waiting for the next
   * poll tick). Returns `null` if the daemon's payload was
   * unparseable; throws on BLE errors. */
  getStatus: () => Promise<BleWifiStatus | null>;
  /** Run the `WIFI_PROBE` BLE diagnostic and return the parsed result.
   * No auth required (read-only). Resolves to `null` if the BLE
   * exchange succeeded but the payload was unparseable, throws on
   * BLE errors. */
  probe: () => Promise<WifiProbeResult | null>;
  clearError: () => void;
}

export function useWifiSetup(): UseWifiSetupResult {
  const { sendCommand, disconnectDevice, connectedAddress } = useBleSession();

  const [status, setStatus] = useState<BleWifiStatus | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [scanResults, setScanResults] = useState<string[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollIntervalRef = useRef<IntervalHandle | null>(null);
  const fastPollTimeoutRef = useRef<TimeoutHandle | null>(null);
  const pollInFlightRef = useRef(false);
  const userActionInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const clearError = useCallback(() => setError(null), []);

  const pollOnce = useCallback(async () => {
    if (!connectedAddress) return;
    if (pollInFlightRef.current) return;
    // Stand down while a user-initiated call holds the command queue -
    // otherwise the poll just queues behind it and makes the UI feel
    // laggy.
    if (userActionInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      const raw = await sendCommand('WIFI_STATUS');
      if (!mountedRef.current) return;
      const parsed = parseWifiStatus(raw);
      if (parsed) setStatus(parsed);
    } catch (err) {
      // Don't surface poll errors in the banner - they're almost always
      // transient (write racing with a previous write ack, etc.). The
      // next tick will try again.
      console.warn('[useWifiSetup] status poll failed', err);
    } finally {
      pollInFlightRef.current = false;
    }
  }, [connectedAddress, sendCommand]);

  const stopFastPoll = useCallback(() => {
    if (fastPollTimeoutRef.current !== null) {
      clearTimeout(fastPollTimeoutRef.current);
      fastPollTimeoutRef.current = null;
    }
  }, []);

  const schedulePoll = useCallback(
    (intervalMs: number) => {
      if (pollIntervalRef.current !== null) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (!connectedAddress) return;
      pollIntervalRef.current = setInterval(() => {
        void pollOnce();
      }, intervalMs);
    },
    [connectedAddress, pollOnce]
  );

  const startFastPoll = useCallback(() => {
    schedulePoll(FAST_POLL_MS);
    stopFastPoll();
    fastPollTimeoutRef.current = setTimeout(() => {
      schedulePoll(STATUS_POLL_MS);
      fastPollTimeoutRef.current = null;
    }, FAST_POLL_DURATION_MS);
  }, [schedulePoll, stopFastPoll]);

  // Lifecycle: poll while connected.
  useEffect(() => {
    mountedRef.current = true;
    if (!connectedAddress) {
      setStatus(null);
      setScanResults([]);
      setIsAuthenticated(false);
      return;
    }
    // Fire one immediate poll so the UI shows real state instead of a
    // 3-second-old `null` placeholder.
    void pollOnce();
    schedulePoll(STATUS_POLL_MS);
    return () => {
      mountedRef.current = false;
      if (pollIntervalRef.current !== null) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      stopFastPoll();
    };
  }, [connectedAddress, pollOnce, schedulePoll, stopFastPoll]);

  const refresh = useCallback(async () => {
    await pollOnce();
  }, [pollOnce]);

  const getStatus = useCallback(async (): Promise<BleWifiStatus | null> => {
    // Direct one-shot read - intentionally side-effect free. We do
    // NOT update `setup.status` here: callers want a snapshot in a
    // routing decision, not to drive the polling state. The next
    // `pollOnce` will refresh the cached state in due course.
    const raw = await sendCommand('WIFI_STATUS');
    return parseWifiStatus(raw);
  }, [sendCommand]);

  const authenticate = useCallback(
    async (pin: string): Promise<boolean> => {
      const trimmed = pin.trim();
      if (!trimmed) {
        setError('PIN is required');
        return false;
      }
      setIsBusy(true);
      setError(null);
      userActionInFlightRef.current = true;
      try {
        const resp = await sendCommand(`PIN_${trimmed}`);
        if (!resp.startsWith('OK:')) {
          const lower = resp.toLowerCase();
          setError(
            lower.includes('incorrect pin')
              ? 'Incorrect PIN. Check the 5-digit code printed on the robot.'
              : resp
          );
          setIsAuthenticated(false);
          return false;
        }
        setIsAuthenticated(true);
        return true;
      } catch (err) {
        setError(formatBlecError(err));
        setIsAuthenticated(false);
        return false;
      } finally {
        setIsBusy(false);
        userActionInFlightRef.current = false;
      }
    },
    [sendCommand]
  );

  const scan = useCallback(async (): Promise<string[]> => {
    setIsBusy(true);
    setError(null);
    userActionInFlightRef.current = true;
    try {
      const raw = await sendCommand('WIFI_SCAN', { delayMs: WIFI_SCAN_READ_DELAY_MS });
      if (raw.startsWith('ERROR:')) {
        const msg = raw.slice('ERROR:'.length).trim();
        if (msg.toLowerCase().includes('not connected')) setIsAuthenticated(false);
        setError(msg);
        return [];
      }
      const ssids = safeJsonParse<string[]>(raw);
      if (!Array.isArray(ssids)) {
        setError('Unexpected scan payload from the daemon.');
        return [];
      }
      setScanResults(ssids);
      return ssids;
    } catch (err) {
      setError(formatBlecError(err));
      return [];
    } finally {
      setIsBusy(false);
      userActionInFlightRef.current = false;
    }
  }, [sendCommand]);

  const connect = useCallback(
    async (ssid: string, psk: string): Promise<boolean> => {
      const trimmed = ssid.trim();
      if (!trimmed) {
        setError('SSID is required');
        return false;
      }
      setIsBusy(true);
      setError(null);
      // Clear the cached status so the auto-advance effect on the
      // joining screen cannot fire on a stale `mode: 'wlan'` from the
      // previous WiFi session (e.g. when the user came in via the
      // "Already on Wi-Fi" path and wants to switch network). The
      // first poll after WIFI_CONNECT will re-populate this with the
      // authoritative post-attempt state.
      setStatus(null);
      userActionInFlightRef.current = true;
      try {
        const payload = JSON.stringify({ ssid: trimmed, psk });
        const resp = await sendCommand(`WIFI_CONNECT ${payload}`);
        if (resp.startsWith('ERROR:')) {
          const msg = resp.slice('ERROR:'.length).trim();
          if (msg.toLowerCase().includes('not connected')) setIsAuthenticated(false);
          setError(msg);
          return false;
        }
        startFastPoll();
        return true;
      } catch (err) {
        setError(formatBlecError(err));
        return false;
      } finally {
        setIsBusy(false);
        userActionInFlightRef.current = false;
      }
    },
    [sendCommand, startFastPoll]
  );

  const probe = useCallback(async (): Promise<WifiProbeResult | null> => {
    // No `setIsBusy` here: the WiFi screen renders the diagnostic
    // result inside `FailedView`, which already has its own local
    // loading state. Surfacing it via `isBusy` would block legitimate
    // background polls and feel wrong (probe is not a write, it
    // doesn't take the daemon's `busy_lock`).
    setError(null);
    try {
      const raw = await sendCommand('WIFI_PROBE', {
        delayMs: WIFI_PROBE_READ_DELAY_MS,
      });
      if (raw.startsWith('ERROR:')) {
        setError(raw.slice('ERROR:'.length).trim());
        return null;
      }
      const parsed = safeJsonParse<Partial<WifiProbeResult>>(raw);
      if (!parsed || typeof parsed !== 'object') {
        setError('Unexpected diagnostic payload from the daemon.');
        return null;
      }
      // Coerce missing keys to `unknown` so the UI can render every
      // row without runtime guards. The daemon always emits all five,
      // but a future version might add new ones; we only validate the
      // shape we know.
      return {
        wlan: typeof parsed.wlan === 'string' ? parsed.wlan : 'unknown',
        gateway: typeof parsed.gateway === 'string' ? parsed.gateway : 'unknown',
        dns: typeof parsed.dns === 'string' ? parsed.dns : 'unknown',
        internet: typeof parsed.internet === 'string' ? parsed.internet : 'unknown',
        daemon: typeof parsed.daemon === 'string' ? parsed.daemon : 'unknown',
      };
    } catch (err) {
      setError(formatBlecError(err));
      throw err;
    }
  }, [sendCommand]);

  const forget = useCallback(
    async (
      ssid: string,
      options?: { disconnectAfter?: boolean }
    ): Promise<boolean> => {
      const disconnectAfter = options?.disconnectAfter ?? true;
      setIsBusy(true);
      setError(null);
      userActionInFlightRef.current = true;
      try {
        const resp = await sendCommand(`WIFI_FORGET ${ssid}`);
        if (resp.startsWith('ERROR:')) {
          const msg = resp.slice('ERROR:'.length).trim();
          setError(msg);
          return false;
        }
        if (disconnectAfter) {
          // The robot is about to drop off the user's WiFi. Releasing
          // our BLE session here lets the user restart a fresh
          // discover + provision cycle without any stale state: it's
          // the exact UX the product wants ("forget -> deco -> retry").
          await disconnectDevice();
        } else {
          startFastPoll();
        }
        return true;
      } catch (err) {
        setError(formatBlecError(err));
        return false;
      } finally {
        setIsBusy(false);
        userActionInFlightRef.current = false;
      }
    },
    [sendCommand, disconnectDevice, startFastPoll]
  );

  return {
    status,
    isAuthenticated,
    scanResults,
    isBusy,
    error,
    authenticate,
    scan,
    connect,
    forget,
    refresh,
    getStatus,
    probe,
    clearError,
  };
}

// ===========================================================================
// Helpers
// ===========================================================================

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Parse the JSON payload returned by `WIFI_STATUS`. Returns `null` if
 * the daemon sent something unparseable - callers keep showing the
 * last good status instead of bouncing between "connected" and "reading". */
function parseWifiStatus(raw: string): BleWifiStatus | null {
  const parsed = safeJsonParse<Partial<BleWifiStatus>>(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    mode: typeof parsed.mode === 'string' ? parsed.mode : null,
    connected: typeof parsed.connected === 'string' ? parsed.connected : null,
    known: Array.isArray(parsed.known)
      ? parsed.known.filter((v): v is string => typeof v === 'string')
      : [],
    error: typeof parsed.error === 'string' ? parsed.error : null,
  };
}
