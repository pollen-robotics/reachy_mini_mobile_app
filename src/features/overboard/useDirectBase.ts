/**
 * Direct Bluetooth control of the wheeled base, no robot involved.
 *
 * Exposes the same `HoverboardBaseHandle` as the daemon path
 * (`useHoverboardBase`), so `BaseControls` and the wheels joystick work
 * unchanged, plus an `OverboardLink` for the drive loop. The status is
 * synthesised from the firmware's own status lines instead of the
 * daemon's `hoverboard_get_status`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  BASE_DEVICE_NAME,
  encodeDrive,
  parseStatusLine,
  sppNative,
  WIRE,
  type BondedDevice,
  type DirectTelemetry,
} from './direct-link';
import { basePhase, type HoverboardStatus } from './hoverboard';
import { emptyStats, type OverboardLink } from './link';
import type { BaseCommand, HoverboardBaseHandle } from './useHoverboardBase';

const ADDRESS_KEY = 'overboard.direct.address';
/** A stop within this window of our own sit/STOP is ours, not the board's. */
const CLIENT_STOP_WINDOW_MS = 1500;
const TICK_MS = 500;

function readSavedAddress(): string | null {
  try {
    return localStorage.getItem(ADDRESS_KEY);
  } catch {
    return null;
  }
}

function saveAddress(address: string) {
  try {
    localStorage.setItem(ADDRESS_KEY, address);
  } catch {
    // Remembering the base is a convenience only.
  }
}

export interface DirectBaseHandle {
  base: HoverboardBaseHandle;
  link: OverboardLink;
  devices: BondedDevice[] | null;
  devicesError: string | null;
  address: string | null;
  setAddress(address: string): void;
  refreshDevices(): void;
}

export function useDirectBase(): DirectBaseHandle {
  const [devices, setDevices] = useState<BondedDevice[] | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [address, setAddressState] = useState<string | null>(readSavedAddress);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [pending, setPending] = useState<BaseCommand | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<DirectTelemetry | null>(null);
  const [acks, setAcks] = useState(false);
  const [balancerRequested, setBalancerRequested] = useState(false);
  const [lastStop, setLastStop] = useState<HoverboardStatus['last_stop']>(null);
  const [now, setNow] = useState(() => Date.now());

  const connectedRef = useRef(false);
  connectedRef.current = connected;
  const lastClientStopAt = useRef(0);
  const prevState = useRef<string | null>(null);

  const setAddress = useCallback((a: string) => {
    setAddressState(a);
    saveAddress(a);
  }, []);

  const refreshDevices = useCallback(() => {
    setDevicesError(null);
    sppNative
      .bonded()
      .then((list) => {
        setDevices(list);
        // First visit: pick the base if it's paired.
        setAddressState((current) => {
          if (current && list.some((d) => d.address === current)) return current;
          const base = list.find((d) => d.name === BASE_DEVICE_NAME);
          if (base) saveAddress(base.address);
          return base?.address ?? current;
        });
      })
      .catch((e: unknown) => setDevicesError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Native events: status lines, acks, link loss.
  useEffect(() => {
    void sppNative
      .listen((event) => {
        if (event.type === 'disconnected') {
          setConnected(false);
          setError(`Link lost: ${event.reason}`);
          if (prevState.current === 'Balancing' || prevState.current === 'Liftoff') {
            setLastStop({ reason: 'link_lost', detail: null });
          }
          prevState.current = null;
          setTelemetry(null);
          return;
        }
        const line = event.line;
        if (line.startsWith('ok ')) {
          setAcks(true);
          return;
        }
        const t = parseStatusLine(line);
        if (!t) return;
        const was = prevState.current;
        const enabled = (s: string | null) => s === 'Balancing' || s === 'Liftoff';
        if (enabled(was) && !enabled(t.state) && Date.now() - lastClientStopAt.current > CLIENT_STOP_WINDOW_MS) {
          setLastStop({ reason: 'board', detail: `base went ${t.state} on its own` });
          setBalancerRequested(false);
        }
        prevState.current = t.state;
        setTelemetry(t);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    refreshDevices();
  }, [refreshDevices]);

  // Age the telemetry so a stalled link reads as unknown.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const write = useCallback((data: string) => sppNative.write(data), []);

  // Zero the drive whenever the app stops driving: backgrounded or screen left.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden' && connectedRef.current) void write(WIRE.zero).catch(() => {});
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      if (connectedRef.current) {
        // Free the base's single Bluetooth slot for the robot.
        void write(WIRE.zero)
          .catch(() => {})
          .finally(() => void sppNative.disconnect().catch(() => {}));
      }
    };
  }, [write]);

  const runAsync = useCallback(
    async (command: BaseCommand) => {
      if (command !== 'stop') setPending(command);
      try {
        if (command === 'connect') {
          if (!address) throw new Error(`Pair "${BASE_DEVICE_NAME}" in Android Bluetooth settings first`);
          setConnecting(true);
          setError(null);
          try {
            await sppNative.connect(address);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // The ESP32 takes one client: the robot may be holding it.
            throw new Error(`${msg}. Is Reachy Mini (or the Mac) connected to the base?`);
          } finally {
            setConnecting(false);
          }
          setConnected(true);
          setAcks(false);
          setLastStop(null);
          await write(WIRE.zero);
        } else if (command === 'enable') {
          await write(WIRE.standUp);
          setBalancerRequested(true);
          setLastStop(null);
        } else if (command === 'sit' || command === 'stop') {
          lastClientStopAt.current = Date.now();
          await write(command === 'sit' ? WIRE.sit : WIRE.stop);
          setBalancerRequested(false);
          setLastStop({ reason: command === 'sit' ? 'sit_command' : 'stop_command', detail: null });
        } else if (command === 'disconnect') {
          lastClientStopAt.current = Date.now();
          await write(WIRE.zero).catch(() => {});
          await sppNative.disconnect();
          setConnected(false);
          setTelemetry(null);
          prevState.current = null;
          setBalancerRequested(false);
        }
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending((p) => (p === command ? null : p));
      }
    },
    [address, write],
  );
  const run = useCallback((command: BaseCommand) => void runAsync(command), [runAsync]);

  const status: HoverboardStatus = useMemo(() => {
    const ageS = telemetry ? (now - telemetry.at) / 1000 : null;
    const device = devices?.find((d) => d.address === address);
    return {
      enabled: true,
      link: {
        kind: connected ? 'bluetooth' : null,
        target: device?.name ?? address,
        connected,
        connecting,
        reconnecting: false,
        error: null,
      },
      firmware: { acks, telemetry: telemetry !== null },
      drive: { throttle: 0, turn: 0, balancer_requested: balancerRequested, zeroed_by_deadman: false },
      telemetry: telemetry
        ? { state: telemetry.state, tilt_deg: telemetry.tiltDeg, battery_v: telemetry.batteryV }
        : null,
      telemetry_age_s: ageS,
      last_stop: lastStop,
    };
  }, [telemetry, now, devices, address, connected, connecting, acks, balancerRequested, lastStop]);

  const [link] = useState<OverboardLink>(() => {
    const stats = emptyStats();
    return {
      mode: 'ble',
      send(drive) {
        if (!connectedRef.current) return;
        stats.sent += 1;
        void sppNative.write(encodeDrive(drive)).catch(() => {});
      },
      getStats: () => ({ ...stats }),
      dispose() {},
    };
  });

  return {
    base: { status, phase: basePhase(status), pending, error, run, runAsync },
    link,
    devices,
    devicesError,
    address,
    setAddress,
    refreshDevices,
  };
}
