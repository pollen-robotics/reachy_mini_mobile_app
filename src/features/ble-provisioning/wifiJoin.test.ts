/**
 * `joinNetwork` sequencing over a mocked protocol layer: the saved-network
 * re-key (forget before connect), switching away from a network the robot is
 * already on (whose stale status must not read as "joined"), and the two
 * typed failures.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { WifiStatus } from './protocol';

const connectSealed = vi.fn();
const forgetNetwork = vi.fn();
const readNetworkInfo = vi.fn();
const scanWifi = vi.fn();
const wifiStatus = vi.fn();

vi.mock('./protocol', () => ({ connectSealed, forgetNetwork, readNetworkInfo, scanWifi, wifiStatus }));

const { WifiJoinError, joinNetwork, scanWifiResilient } = await import('./wifiJoin');

const status = (s: Partial<WifiStatus>): WifiStatus => ({ mode: 'wlan', connected: null, error: null, ...s });
const base = { pin: '01202', keyex: '{}', isStale: () => false, pollIntervalMs: 0 };

const net = (mode: string, ip: string | null) => ({ mode, ip, raw: '' });

beforeEach(() => {
  for (const m of [connectSealed, forgetNetwork, readNetworkInfo, scanWifi, wifiStatus]) m.mockReset();
  // First read = where the robot is before the join (its hotspot), then the new LAN.
  readNetworkInfo.mockResolvedValueOnce(net('hotspot', '10.42.0.1'));
  readNetworkInfo.mockResolvedValue(net('connected', '192.168.1.42'));
});

it('switches from the current network and resolves the new IP', async () => {
  wifiStatus
    .mockResolvedValueOnce(status({ connected: 'Home' })) // switch not started yet
    .mockResolvedValueOnce(status({ connected: 'Office', mode: 'busy' })) // still joining
    .mockResolvedValueOnce(status({ connected: 'Office' }));

  await expect(joinNetwork({ ...base, ssid: 'Office', password: 'secret', known: ['Home'] })).resolves.toBe(
    '192.168.1.42',
  );
  expect(forgetNetwork).not.toHaveBeenCalled();
  expect(connectSealed).toHaveBeenCalledWith('Office', 'secret', '01202', '{}');
});

it('forgets a saved network before re-keying it with a new password', async () => {
  wifiStatus
    .mockResolvedValueOnce(status({ mode: 'busy', known: ['Home', 'Office'] }))
    .mockResolvedValueOnce(status({ connected: 'Home', known: ['Home'] }))
    .mockResolvedValueOnce(status({ connected: 'Office' }));

  await joinNetwork({ ...base, ssid: 'Office', password: 'new', known: ['Home', 'Office'] });

  expect(forgetNetwork).toHaveBeenCalledWith('Office');
  expect(forgetNetwork.mock.invocationCallOrder[0]).toBeLessThan(connectSealed.mock.invocationCallOrder[0]);
});

it('joins a saved network with its saved password when none is typed', async () => {
  wifiStatus.mockResolvedValueOnce(status({ connected: 'Home' }));

  await joinNetwork({ ...base, ssid: 'Home', password: '', known: ['Home'] });

  expect(forgetNetwork).not.toHaveBeenCalled();
  expect(connectSealed).toHaveBeenCalledWith('Home', '', '01202', '{}');
});

it('waits for the LAN IP before calling it joined', async () => {
  wifiStatus.mockResolvedValue(status({ connected: 'Office' }));
  readNetworkInfo
    .mockReset()
    .mockResolvedValueOnce(net('hotspot', '10.42.0.1'))
    .mockResolvedValueOnce(net('offline', null))
    .mockRejectedValueOnce(new Error('read timeout'))
    .mockResolvedValueOnce(net('connected', '10.0.0.7'));

  await expect(joinNetwork({ ...base, ssid: 'Office', password: 'pw' })).resolves.toBe('10.0.0.7');
  expect(wifiStatus).toHaveBeenCalledTimes(3);
});

it("doesn't take the old network's IP for a join still in progress", async () => {
  // Seen on a robot: mid-join WIFI_STATUS already names the new SSID while
  // NETWORK_STATUS still reports the old network's address.
  readNetworkInfo.mockReset().mockResolvedValue(net('connected', '192.168.1.97'));
  wifiStatus
    .mockResolvedValueOnce(status({ connected: 'Office', mode: 'busy' }))
    .mockResolvedValueOnce(status({ connected: 'Office', mode: 'busy' }))
    .mockResolvedValueOnce(status({ mode: 'hotspot', connected: 'Hotspot', error: 'Secrets were required' }));

  const err = await joinNetwork({ ...base, ssid: 'Office', password: 'nope' }).catch(e => e);
  expect(err).toBeInstanceOf(WifiJoinError);
  expect(err.code).toBe('wrong-password');
});

it('trusts an unchanged IP only once the network status has refreshed', async () => {
  readNetworkInfo.mockReset().mockResolvedValue(net('connected', '192.168.1.97'));
  wifiStatus.mockResolvedValue(status({ connected: 'Office' }));

  const t0 = Date.now();
  await expect(
    joinNetwork({ ...base, ssid: 'Office', password: 'pw', pollIntervalMs: 5, netStatusRefreshMs: 60 }),
  ).resolves.toBe('192.168.1.97');
  expect(Date.now() - t0).toBeGreaterThanOrEqual(60);
});

it('reports a refused network as a wrong password', async () => {
  wifiStatus.mockResolvedValueOnce(status({ mode: 'hotspot', connected: 'Hotspot', error: 'Secrets were required' }));

  const err = await joinNetwork({ ...base, ssid: 'Office', password: 'nope' }).catch(e => e);
  expect(err).toBeInstanceOf(WifiJoinError);
  expect(err.code).toBe('wrong-password');
});

it('times out when the robot never gets there', async () => {
  wifiStatus.mockResolvedValue(status({ connected: 'Home' }));

  const err = await joinNetwork({ ...base, ssid: 'Office', password: 'pw', timeoutMs: 0 }).catch(e => e);
  expect(err).toBeInstanceOf(WifiJoinError);
  expect(err.code).toBe('timeout');
});

it('stops quietly once the caller moved on', async () => {
  let stale = false;
  connectSealed.mockImplementation(async () => {
    stale = true;
  });

  await expect(joinNetwork({ ...base, ssid: 'Office', password: 'pw', isStale: () => stale })).resolves.toBeNull();
  expect(wifiStatus).not.toHaveBeenCalled();
});

it('retries an empty or busy scan', async () => {
  scanWifi
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('ERROR: Busy'))
    .mockResolvedValueOnce(['Home']);

  await expect(scanWifiResilient(() => false, { retryDelayMs: 0 })).resolves.toEqual(['Home']);
});
