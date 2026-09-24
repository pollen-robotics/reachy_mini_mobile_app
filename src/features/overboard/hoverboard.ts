/**
 * Daemon-side hoverboard (wheeled base) surface, as seen from the app.
 *
 * The daemon's `HoverboardManager` owns the link to the base (USB first,
 * else the remembered Bluetooth MAC) and answers these data-channel
 * commands, each replying `{"status": "ok", "command": <type>}` or
 * `{"error": "...", "command": <type>}`:
 *
 *   hoverboard_connect        bring the link up ({link?: auto|usb|bluetooth}); takes seconds
 *   hoverboard_enable         lift off and balance (firmware S0)
 *   hoverboard_sit            controlled sit-down (needs the wheels on the ground)
 *   hoverboard_stop           motors off NOW (the emergency button)
 *   hoverboard_drive          throttle / turn, see `webrtc-link.ts`
 *   hoverboard_get_status     full status, shape below
 *
 * The 30 Hz pose stream also carries a `hoverboard` summary, but the SDK
 * drops unknown state fields, so the app polls `hoverboard_get_status`.
 */

export type HoverboardFirmwareState = 'Stopped' | 'Liftoff' | 'Balancing' | 'Stopping';

export interface HoverboardStatus {
  enabled: boolean;
  link: {
    kind: 'usb' | 'bluetooth' | null;
    target: string | null;
    connected: boolean;
    connecting: boolean;
    /** Daemon is re-dialing Bluetooth by itself after a link drop. */
    reconnecting: boolean;
    error: string | null;
  };
  firmware: { acks: boolean; telemetry: boolean };
  drive: {
    throttle: number;
    turn: number;
    balancer_requested: boolean;
    zeroed_by_deadman: boolean;
  };
  /** Null on the stock (silent) firmware. */
  telemetry: {
    state: HoverboardFirmwareState | string;
    tilt_deg: number;
    /** Supply voltage, null until a firmware reports it. */
    battery_v: number | null;
  } | null;
  telemetry_age_s: number | null;
  /** Why the base last left Liftoff/Balancing; null on older daemons or before any stop. */
  last_stop: { reason: StopReason | string; detail: string | null } | null;
}

/** `board` = the base stopped on its own (tilt cutoff, power, another link). */
export type StopReason = 'stop_command' | 'sit_command' | 'disconnect' | 'link_lost' | 'board';

/**
 * Stops the user didn't ask for, worth explaining while the base rests.
 * Clock-free on purpose (phone and robot clocks differ): it shows until
 * the phase moves on or a newer stop replaces it.
 */
export function unexpectedStop(status: HoverboardStatus | null): string | null {
  const stop = status?.last_stop;
  if (!stop || (stop.reason !== 'board' && stop.reason !== 'link_lost')) return null;
  const phase = basePhase(status);
  if (phase !== 'sitting' && phase !== 'offline' && phase !== 'connecting') return null;
  if (stop.reason === 'link_lost') return 'Stopped: link to the base lost';
  return `Stopped by the base${stop.detail ? ` (${stop.detail})` : ''}`;
}

/**
 * What the telepresence UI shows and allows, derived from one status.
 *
 *   unavailable  daemon has no hoverboard support (or never answered)
 *   offline      no link to the base          → Connect
 *   connecting   link coming up
 *   sitting      connected, motors off        → Stand up
 *   lifting      S0 sent, not balancing yet
 *   balancing    driving allowed              → Sit
 *   stopping     sit-down in progress
 */
export type BasePhase =
  | 'unavailable'
  | 'offline'
  | 'connecting'
  | 'sitting'
  | 'lifting'
  | 'balancing'
  | 'stopping';

/** Telemetry older than this is treated as missing (link stalled). */
const TELEMETRY_STALE_S = 2;

export function basePhase(status: HoverboardStatus | null): BasePhase {
  if (!status || !status.enabled) return 'unavailable';
  if (status.link.connecting || status.link.reconnecting) return 'connecting';
  if (!status.link.connected) return 'offline';
  const t = status.telemetry;
  const fresh = t !== null && (status.telemetry_age_s ?? Infinity) < TELEMETRY_STALE_S;
  if (fresh) {
    if (t.state === 'Balancing') return 'balancing';
    if (t.state === 'Liftoff') return 'lifting';
    if (t.state === 'Stopping') return 'stopping';
    return 'sitting';
  }
  // Stock firmware is silent: trust what we last asked for.
  return status.drive.balancer_requested ? 'balancing' : 'sitting';
}

/** Tolerant parse of the `hoverboard` payload; null when it isn't one. */
export function parseStatus(raw: unknown): HoverboardStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<HoverboardStatus>;
  if (typeof s.enabled !== 'boolean' || !s.link || !s.drive) return null;
  return {
    enabled: s.enabled,
    link: {
      kind: s.link.kind ?? null,
      target: s.link.target ?? null,
      connected: Boolean(s.link.connected),
      connecting: Boolean(s.link.connecting),
      reconnecting: Boolean(s.link.reconnecting),
      error: s.link.error ?? null,
    },
    firmware: { acks: Boolean(s.firmware?.acks), telemetry: Boolean(s.firmware?.telemetry) },
    drive: {
      throttle: Number(s.drive.throttle) || 0,
      turn: Number(s.drive.turn) || 0,
      balancer_requested: Boolean(s.drive.balancer_requested),
      zeroed_by_deadman: Boolean(s.drive.zeroed_by_deadman),
    },
    telemetry: s.telemetry
      ? {
          state: String(s.telemetry.state),
          tilt_deg: Number(s.telemetry.tilt_deg) || 0,
          battery_v: typeof s.telemetry.battery_v === 'number' ? s.telemetry.battery_v : null,
        }
      : null,
    telemetry_age_s: typeof s.telemetry_age_s === 'number' ? s.telemetry_age_s : null,
    last_stop: s.last_stop
      ? { reason: String(s.last_stop.reason), detail: s.last_stop.detail ?? null }
      : null,
  };
}
