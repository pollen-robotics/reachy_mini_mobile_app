/**
 * Tests for the daemon's plain-text NETWORK_STATUS payload parser.
 *
 * Format (sourced from `bluetooth_service.py::get_network_status`):
 *
 *   "MODE [iface] ip [ ; [iface] ip ]*"
 *   "OFFLINE"
 *   "ERROR"
 *
 * MODE is uppercase on the wire; the parser lowercases it to match
 * the rest of the app's vocabulary. Interface preference is wlan0
 * > eth0 > first-listed.
 */
import { describe, expect, it } from 'vitest';

import { parseNetworkStatus } from './networkStatus';

describe('parseNetworkStatus', () => {
  it('returns null on the empty payload', () => {
    expect(parseNetworkStatus('')).toBeNull();
  });

  it("returns null on the 'ERROR' sentinel", () => {
    expect(parseNetworkStatus('ERROR')).toBeNull();
  });

  it('returns mode-only without ip when payload is bare "OFFLINE"', () => {
    expect(parseNetworkStatus('OFFLINE')).toEqual({
      hostname: '',
      ip: null,
      port: 8000,
      mode: 'offline',
    });
  });

  it('parses a single connected interface', () => {
    expect(parseNetworkStatus('CONNECTED [wlan0] 192.168.1.19')).toEqual({
      hostname: '',
      ip: '192.168.1.19',
      port: 8000,
      mode: 'connected',
    });
  });

  it('parses HOTSPOT mode with the AP-side address', () => {
    expect(parseNetworkStatus('HOTSPOT [wlan0] 10.42.0.1')).toEqual({
      hostname: '',
      ip: '10.42.0.1',
      port: 8000,
      mode: 'hotspot',
    });
  });

  it('prefers wlan0 over eth0 when both are listed', () => {
    expect(
      parseNetworkStatus(
        'CONNECTED [eth0] 10.0.0.5 ; [wlan0] 192.168.1.19',
      ),
    ).toEqual({
      hostname: '',
      ip: '192.168.1.19',
      port: 8000,
      mode: 'connected',
    });
  });

  it('falls back to eth0 when wlan0 is absent', () => {
    expect(
      parseNetworkStatus('CONNECTED [eth0] 10.0.0.5 ; [usb0] 169.254.1.1'),
    ).toEqual({
      hostname: '',
      ip: '10.0.0.5',
      port: 8000,
      mode: 'connected',
    });
  });

  it('falls back to the first-listed interface when no wlan0/eth0', () => {
    expect(
      parseNetworkStatus('CONNECTED [usb0] 169.254.1.1 ; [wg0] 10.20.30.40'),
    ).toEqual({
      hostname: '',
      ip: '169.254.1.1',
      port: 8000,
      mode: 'connected',
    });
  });

  it('lowercases the leading mode token', () => {
    // Robustness: even if a future daemon emits camelCase or mixed
    // case we still normalise to the same downstream key.
    expect(parseNetworkStatus('Connected [wlan0] 10.0.0.1')?.mode).toBe(
      'connected',
    );
  });

  it('tolerates trailing whitespace inside interface entries', () => {
    expect(
      parseNetworkStatus('CONNECTED [wlan0]   192.168.1.19   ; [eth0] 10.0.0.5'),
    ).toEqual({
      hostname: '',
      ip: '192.168.1.19',
      port: 8000,
      mode: 'connected',
    });
  });

  it('returns mode + null ip when entries fail the regex', () => {
    // The daemon never emits this shape, but an empty interface
    // list after a recognised mode shouldn't blow up the parser.
    expect(parseNetworkStatus('CONNECTED garbage-no-brackets')).toEqual({
      hostname: '',
      ip: null,
      port: 8000,
      mode: 'connected',
    });
  });
});
