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
  defaultWireSigns,
  isBaseName,
  encodeDrive,
  errorText,
  parseStatusLine,
  sppNative,
  WIRE,
  type BondedDevice,
  type DirectTelemetry,
  type WireSigns,
} from './direct-link';
import { basePhase, type HoverboardStatus } from './hoverboard';
import { emptyStats, type OverboardLink } from './link';
import type { BaseCommand, HoverboardBaseHandle } from './useHoverboardBase';

const ADDRESS_KEY = 'overboard.direct.address';
/** A stop within this window of our own sit/STOP is ours, not the board's. */
const CLIENT_STOP_WINDOW_MS = 1500;
const TICK_MS = 500;
/** No ack or status line this long after connecting = stock (silent) firmware. */
const SILENT_AFTER_MS = 3000;
const SIGNS_KEY = 'overboard.direct.signs.';

function readSigns(address: string | null): WireSigns {
  try {
    const raw = address ? localStorage.getItem(SIGNS_KEY + address) : null;
    if (raw) return JSON.parse(raw) as WireSigns;
  } catch {
    // Fall back to the default for this base.
  }
  return defaultWireSigns(address);
}

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
  /** Bluetooth discovery in progress. */
  scanning: boolean;
  /** How forward / left map to the wire for the selected base. */
  signs: WireSigns;
  setSigns(signs: WireSigns): void;
  /** Connected for a while without a single ack or status line: stock firmware. */
  firmwareSilent: boolean;
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
  const [signs, setSignsState] = useState<WireSigns>(() => readSigns(address));
  const signsRef = useRef(signs);
  signsRef.current = signs;
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [heardFromBase, setHeardFromBase] = useState(false);

  const connectedRef = useRef(false);
  connectedRef.current = connected;
  const lastClientStopAt = useRef(0);
  const prevState = useRef<string | null>(null);

  const setAddress = useCallback((a: string) => {
    setAddressState(a);
    saveAddress(a);
    setSignsState(readSigns(a));
  }, []);

  const setSigns = useCallback(
    (s: WireSigns) => {
      setSignsState(s);
      try {
        if (address) localStorage.setItem(SIGNS_KEY + address, JSON.stringify(s));
      } catch {
        // Remembered per base for convenience only.
      }
    },
    [address],
  );

  const [scanning, setScanning] = useState(false);

  const showDevices = useCallback((list: BondedDevice[]) => {
        // Bases first, by number; other paired devices after.
        setDevices(
          [...list].sort(
            (a, b) =>
              Number(isBaseName(b.name)) - Number(isBaseName(a.name)) ||
              a.name.localeCompare(b.name, undefined, { numeric: true }),
          ),
        );
        // First visit: pick the base if it's paired.
        setAddressState((current) => {
          if (current && list.some((d) => d.address === current)) return current;
          // Only auto-pick when there's a single base: several paired
          // rmini_wheels look identical, the user has to choose.
          const bases = list.filter((d) => isBaseName(d.name));
          const base = bases.length === 1 ? bases[0] : undefined;
          if (base) {
            saveAddress(base.address);
            setSignsState(readSigns(base.address));
          }
          return base?.address ?? null;
        });
  }, []);

  // Paired devices right away, then a scan that adds bases in range that
  // aren't paired yet (they pair on Connect).
  const refreshDevices = useCallback(() => {
    setDevicesError(null);
    let paired: BondedDevice[] = [];
    sppNative
      .bonded()
      .then((list) => {
        paired = list;
        showDevices(list);
        setScanning(true);
        return sppNative.scan(8);
      })
      .then((seen) => {
        const known = new Set(paired.map((d) => d.address));
        const extra = seen.filter((d) => isBaseName(d.name) && !known.has(d.address));
        // A paired base renamed by a reflash shows its new name in the scan.
        const renamed = new Map(seen.filter((d) => isBaseName(d.name)).map((d) => [d.address, d.name]));
        showDevices([...paired.map((d) => ({ ...d, name: renamed.get(d.address) ?? d.name })), ...extra]);
      })
      .catch((e: unknown) => setDevicesError(errorText(e)))
      .finally(() => setScanning(false));
  }, [showDevices]);

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
        setHeardFromBase(true);
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
      .catch((e: unknown) => setError(errorText(e)));
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
            // The ESP32 takes one client: the robot or the Mac may be holding
            // it, or this paired base is simply off.
            throw new Error(`${errorText(e)}. Is this base on, and not connected to Reachy Mini or the Mac?`);
          } finally {
            setConnecting(false);
          }
          setConnected(true);
          setConnectedAt(Date.now());
          setHeardFromBase(false);
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
        setError(errorText(e));
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
        void sppNative.write(encodeDrive(drive, signsRef.current)).catch(() => {});
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
    scanning,
    signs,
    setSigns,
    firmwareSilent: connected && !heardFromBase && connectedAt !== null && now - connectedAt > SILENT_AFTER_MS,
  };
}
