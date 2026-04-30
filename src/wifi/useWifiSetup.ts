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

import type { BleWifiProbe, BleWifiStatus } from '../types/robot';
import { formatBlecError, useBleSession } from '../ble/useBleSession';

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
 * `WIFI_PROBE` runs four parallel checks server-side bounded by ~2.5 s.
 * Add a small buffer for BLE round-trip; falling back to legacy HTTP
 * probes is preferable to a hung BLE write.
 */
const WIFI_PROBE_READ_DELAY_MS = 250;
/**
 * If the first probe sees `wlan=ok` but `gateway=fail`, DHCP is likely
 * still in flight. Wait this long, then re-probe ONCE - never loop, the
 * caller decides what to do with the second verdict.
 */
const WIFI_PROBE_RETRY_DELAY_MS = 1_500;

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
  /**
   * Ask the robot to diagnose its own connectivity end-to-end.
   *
   * Returns:
   *   - a parsed `BleWifiProbe` (the modern path, daemon supports
   *     `WIFI_PROBE`),
   *   - `'unsupported'` when the daemon is too old (replied `ECHO:` to
   *     the unknown command), so the caller can fall back to the legacy
   *     HTTP probe loop, or
   *   - `null` on transient BLE error - the caller can retry.
   */
  probe: () => Promise<BleWifiProbe | 'unsupported' | null>;
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

  /**
   * Issue a single `WIFI_PROBE`. Does NOT touch `isBusy` / `error` -
   * this is meant to be called from the connecting takeover where we
   * already drive a richer state machine.
   *
   * Idempotent: a transient BLE failure returns `null` so the caller
   * can retry without state pollution.
   */
  const probe = useCallback(async (): Promise<
    BleWifiProbe | 'unsupported' | null
  > => {
    if (!connectedAddress) return null;
    try {
      const raw = await sendCommand('WIFI_PROBE', {
        delayMs: WIFI_PROBE_READ_DELAY_MS,
      });
      // Daemon-too-old fallback: bluetooth_service.py routes any
      // unknown command through `ECHO: <command>`. Surface this as a
      // distinct outcome so the caller can fall back to legacy HTTP
      // probes instead of treating an old daemon as "no internet".
      if (raw.startsWith('ECHO:')) return 'unsupported';
      if (raw.startsWith('ERROR:')) return null;
      return parseWifiProbe(raw);
    } catch (err) {
      console.warn('[useWifiSetup] probe failed', err);
      return null;
    }
  }, [connectedAddress, sendCommand]);

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
 * last good status instead of bouncing between "connected" and "reading".
 *
 * Exported for reuse by the session controller, which fires a one-shot
 * `WIFI_STATUS` read at the end of the BLE handshake to surface the
 * connected SSID alongside the LAN IP on the connection stepper.
 */
export function parseWifiStatus(raw: string): BleWifiStatus | null {
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

/** Parse the JSON payload returned by `WIFI_PROBE`. Returns `null` on
 * any malformed payload - the caller treats that as a transient BLE
 * error and retries.
 *
 * Field-by-field validation: an unknown daemon could ship a 6th key in
 * the future and we don't want one rogue value to invalidate the whole
 * verdict, so we coerce each known key independently. */
function parseWifiProbe(raw: string): BleWifiProbe | null {
  const parsed = safeJsonParse<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== 'object') return null;

  const wlan =
    parsed.wlan === 'ok' || parsed.wlan === 'hotspot' || parsed.wlan === 'fail'
      ? parsed.wlan
      : null;
  const gateway = parsed.gateway === 'ok' || parsed.gateway === 'fail' ? parsed.gateway : null;
  const dns = parsed.dns === 'ok' || parsed.dns === 'fail' ? parsed.dns : null;
  const internet =
    parsed.internet === 'ok' || parsed.internet === 'fail' ? parsed.internet : null;
  const daemon =
    parsed.daemon === 'ok' || parsed.daemon === 'loading' || parsed.daemon === 'fail'
      ? parsed.daemon
      : null;

  if (!wlan || !gateway || !dns || !internet || !daemon) return null;
  return { wlan, gateway, dns, internet, daemon };
}

/**
 * Probe with a single retry when DHCP is still in flight. Exposed as a
 * helper so the WiFi setup screen can keep its own state machine simple
 * (single call, single verdict).
 *
 * Retry policy: if the first probe sees `wlan=ok` but the gateway/dns
 * pair is failing, the robot most likely just acquired its IP and is
 * waiting on DHCP / DNS warm-up. One retry after
 * `WIFI_PROBE_RETRY_DELAY_MS` is enough; we never loop, so the UI never
 * stalls.
 */
export async function probeWithRetry(
  setup: UseWifiSetupResult
): Promise<BleWifiProbe | 'unsupported' | null> {
  const first = await setup.probe();
  if (first === null || first === 'unsupported') return first;

  const dhcpInFlight =
    first.wlan === 'ok' && (first.gateway === 'fail' || first.dns === 'fail');
  if (!dhcpInFlight) return first;

  await new Promise<void>(r => setTimeout(r, WIFI_PROBE_RETRY_DELAY_MS));
  const second = await setup.probe();
  return second ?? first;
}
