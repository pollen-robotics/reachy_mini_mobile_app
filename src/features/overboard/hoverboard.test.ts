import { describe, expect, it } from 'vitest';

import { basePhase, parseStatus } from './hoverboard';
import { toDriveMessage } from './webrtc-link';

// Trimmed copy of a real `hoverboard_get_status` reply from the daemon.
const REAL = {
  enabled: true,
  link: { kind: 'bluetooth', target: '4C:75:25:E4:B1:D6/1', connected: true, connecting: false, error: null },
  firmware: { acks: true, telemetry: true, last_ack_age_s: 0.82 },
  drive: { throttle: 0, turn: 0, balancer_requested: false, zeroed_by_deadman: false },
  telemetry: { state: 'Stopped', tilt_deg: 3.7 },
  telemetry_age_s: 0.0,
};

const withPatch = (patch: Record<string, unknown>) => parseStatus({ ...REAL, ...patch });

describe('basePhase', () => {
  it('reads a live status', () => {
    expect(basePhase(parseStatus(REAL))).toBe('sitting');
    expect(basePhase(withPatch({ telemetry: { state: 'Balancing', tilt_deg: 0 } }))).toBe('balancing');
    expect(basePhase(withPatch({ telemetry: { state: 'Liftoff', tilt_deg: 0 } }))).toBe('lifting');
    expect(basePhase(withPatch({ telemetry: { state: 'Stopping', tilt_deg: 0 } }))).toBe('stopping');
  });

  it('covers the link states', () => {
    expect(basePhase(null)).toBe('unavailable');
    expect(basePhase(withPatch({ enabled: false }))).toBe('unavailable');
    expect(basePhase(withPatch({ link: { ...REAL.link, connected: false } }))).toBe('offline');
    expect(basePhase(withPatch({ link: { ...REAL.link, connected: false, connecting: true } }))).toBe(
      'connecting',
    );
  });

  it('falls back to the requested balancer on silent or stale telemetry', () => {
    const drive = { ...REAL.drive, balancer_requested: true };
    expect(basePhase(withPatch({ telemetry: null, telemetry_age_s: null, drive }))).toBe('balancing');
    expect(basePhase(withPatch({ telemetry_age_s: 10, drive }))).toBe('balancing');
    expect(basePhase(withPatch({ telemetry: null, telemetry_age_s: null }))).toBe('sitting');
  });

  it('rejects payloads that are not a status', () => {
    expect(parseStatus(undefined)).toBeNull();
    expect(parseStatus({ error: 'hoverboard support is disabled' })).toBeNull();
  });
});

describe('toDriveMessage', () => {
  it('scales to the daemon range', () => {
    expect(toDriveMessage({ linear: 0.42, angular: -0.1 })).toEqual({
      type: 'hoverboard_drive',
      throttle: 42,
      turn: -10,
    });
    expect(toDriveMessage({ linear: 1.5, angular: -0 })).toEqual({ type: 'hoverboard_drive', throttle: 100, turn: 0 });
  });
});
