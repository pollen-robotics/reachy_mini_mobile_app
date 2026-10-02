import { describe, expect, it } from 'vitest';

import { defaultWireSigns, encodeDrive, errorText, parseStatusLine, WIRE } from './direct-link';

const PROTO = defaultWireSigns('4C:75:25:E4:B1:D6');

describe('encodeDrive', () => {
  it('flips throttle and turn like the daemon does for this base', () => {
    // App: forward + left positive. Wire (Rémi's proto): both negated.
    expect(encodeDrive({ linear: 0.5, angular: 0 }, PROTO)).toBe('T-50\nR0\n');
    expect(encodeDrive({ linear: 0, angular: 1 }, PROTO)).toBe('T0\nR-100\n');
    expect(encodeDrive({ linear: -0.256, angular: -0.5 }, PROTO)).toBe('T26\nR50\n');
  });

  it('clamps and never sends -0', () => {
    expect(encodeDrive({ linear: 3, angular: -0 }, PROTO)).toBe('T-100\nR0\n');
  });
});

describe('defaultWireSigns', () => {
  it('uses the prototype mapping for every base', () => {
    expect(encodeDrive({ linear: 0.5, angular: 0.5 }, defaultWireSigns('4C:75:25:E4:AE:2A'))).toBe('T-50\nR-50\n');
    expect(defaultWireSigns(null)).toEqual({ throttle: -1, turn: -1 });
  });
});

describe('errorText', () => {
  it('never shows [object Object]', () => {
    expect(errorText({ message: 'Could not connect: read failed' })).toBe('Could not connect: read failed');
    expect(errorText('Bluetooth is off')).toBe('Bluetooth is off');
    expect(errorText({ code: 3 })).toBe('{"code":3}');
  });
});

describe('WIRE', () => {
  it('matches the daemon sequences', () => {
    expect(WIRE.standUp).toBe('S0\n');
    expect(WIRE.sit).toBe('T0\nR0\nS1\nZ1\n');
    expect(WIRE.stop).toBe('E1\nT0\nR0\nS1\nZ1\n');
  });
});

describe('parseStatusLine', () => {
  it('reads state, tilt and battery from the bench status line', () => {
    const line =
      '[diag] state=Balancing stop_cmd=0.00 angle_deg=1.2 zero_deg=0.0 gyro=0.01 vel_m1=0.10 vel_m2=-0.10 pos=0.00 pos_err=0.00 tar=0 turn=0 vbat=12.01 target=0.10 tm1=0.10 tm2=0.10 dt_ms=2.3';
    expect(parseStatusLine(line, 5)).toEqual({ state: 'Balancing', tiltDeg: 1.2, batteryV: 12.01, at: 5 });
  });

  it('ignores acks and noise, tolerates a missing vbat', () => {
    expect(parseStatusLine('ok T10')).toBeNull();
    expect(parseStatusLine('garbage')).toBeNull();
    expect(parseStatusLine('[diag] state=Stopped angle_deg=-25.8', 1)?.batteryV).toBeNull();
  });
});
