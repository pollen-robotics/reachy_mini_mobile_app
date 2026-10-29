/**
 * `connect()` against a mocked plugin, for the two failure modes that hit a
 * real user: the plugin's scan-window race ("There is no peripheral with
 * id") which must be healed by a targeted rediscovery, and a genuine connect
 * failure which must SURFACE instead of walking the caller into the PIN step
 * with no link. Plus: plugin rejections are plain strings, callers get Errors.
 */
import { beforeEach, expect, it, vi } from 'vitest';

const plugin = {
  startScan: vi.fn(),
  stopScan: vi.fn(),
  checkPermissions: vi.fn(),
  getConnectionUpdates: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  sendString: vi.fn(),
  readString: vi.fn(),
  subscribeString: vi.fn(),
};
// `plugin:blec|remove_bond` and friends, which the npm package doesn't wrap.
const tauriInvoke = vi.fn();

async function load() {
  vi.resetModules();
  vi.doMock('@mnlphlp/plugin-blec', () => plugin);
  vi.doMock('./reachyScan', () => ({ startReachyScan: plugin.startScan }));
  vi.doMock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }));
  return import('./bleWifi');
}

beforeEach(() => {
  for (const fn of Object.values(plugin)) fn.mockReset();
  tauriInvoke.mockReset();
  plugin.stopScan.mockResolvedValue(undefined);
  plugin.disconnect.mockResolvedValue(undefined);
  plugin.subscribeString.mockResolvedValue(undefined);
});

it('heals the scan-window race by rediscovering the robot, then connects', async () => {
  const { connect } = await load();
  plugin.connect
    .mockRejectedValueOnce(new Error('There is no peripheral with id: AA:BB'))
    .mockResolvedValueOnce(undefined);
  // The targeted scan reports the robot shortly after it starts.
  plugin.startScan.mockImplementation(async (handler: (d: unknown) => void) => {
    setTimeout(() => handler([{ address: 'AA:BB', name: 'ReachyMini', rssi: -50 }]), 5);
  });

  await expect(connect('AA:BB')).resolves.toBeUndefined();
  expect(plugin.connect).toHaveBeenCalledTimes(2);
  expect(plugin.startScan).toHaveBeenCalledTimes(1);
  expect(plugin.subscribeString).toHaveBeenCalledTimes(1);
});

it('surfaces a connect that fails twice instead of pretending to be linked', async () => {
  const { connect } = await load();
  // The plugin rejects with a plain string, not an Error.
  plugin.connect.mockRejectedValue('Timeout during execution of Connect');

  await expect(connect('AA:BB')).rejects.toThrow('Timeout during execution of Connect');
  expect(plugin.connect).toHaveBeenCalledTimes(2);
  expect(plugin.startScan).not.toHaveBeenCalled();
  expect(plugin.subscribeString).not.toHaveBeenCalled();
});

it('gives up on the race when the robot never reappears', async () => {
  const { connect } = await load();
  plugin.connect.mockRejectedValue(new Error('There is no peripheral with id: AA:BB'));
  plugin.startScan.mockResolvedValue(undefined); // scan runs, nothing shows up
  vi.useFakeTimers();
  try {
    const p = connect('AA:BB');
    const settled = expect(p).rejects.toThrow('no peripheral with id');
    await vi.advanceTimersByTimeAsync(20_000);
    await settled;
  } finally {
    vi.useRealTimers();
  }
});

it('normalises plain-string plugin rejections into Errors', async () => {
  const { sendCommand } = await load();
  plugin.sendString.mockRejectedValue('write failed');

  const err = await sendCommand('PIN_00000').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe('write failed');
});

// What Android reports when the phone's bond is stale: the link drops while the
// MTU request is pending (see Peripheral.kt `failPendingOperations`).
const STALE_BOND =
  'request_mtu failed: mtu request failed: Connection failed. ' +
  'Status: 5 (GATT_INSUFFICIENT_AUTHENTICATION), State: 0';

it('recognises a stale bond from the Android and iOS failures only', async () => {
  const { isStaleBondError } = await load();
  expect(isStaleBondError(STALE_BOND)).toBe(true);
  expect(isStaleBondError(new Error('Connection failed. Status: 137 (GATT_CONN_TERMINATE_DUE_TO_MIC_FAILURE)'))).toBe(true);
  expect(isStaleBondError('Peer removed pairing information.')).toBe(true);
  expect(isStaleBondError('Connection failed. Status: 133 (GATT_ERROR (133)), State: 0')).toBe(false);
  expect(isStaleBondError('Timeout during execution of Connect')).toBe(false);
});

it('drops a stale bond and reconnects once, without the generic retry', async () => {
  const { connect } = await load();
  plugin.connect.mockRejectedValueOnce(STALE_BOND).mockResolvedValueOnce(undefined);
  tauriInvoke.mockResolvedValue(true);

  await expect(connect('AA:BB')).resolves.toBeUndefined();
  expect(plugin.connect).toHaveBeenCalledTimes(2);
  expect(tauriInvoke).toHaveBeenCalledWith('plugin:blec|remove_bond', { address: 'AA:BB' });
  expect(plugin.subscribeString).toHaveBeenCalledTimes(1);
});

it('asks the user to forget the robot when the bond cannot be dropped', async () => {
  const { connect, StaleBondError } = await load();
  plugin.connect.mockRejectedValue(STALE_BOND);
  tauriInvoke.mockResolvedValue(false); // iOS, or Android refused

  await expect(connect('AA:BB')).rejects.toBeInstanceOf(StaleBondError);
  expect(plugin.connect).toHaveBeenCalledTimes(1);
});

it('asks the user to forget the robot when dropping the bond did not help', async () => {
  const { connect, StaleBondError } = await load();
  plugin.connect.mockRejectedValue(STALE_BOND);
  tauriInvoke.mockResolvedValue(true);

  await expect(connect('AA:BB')).rejects.toBeInstanceOf(StaleBondError);
  expect(plugin.connect).toHaveBeenCalledTimes(2);
});

it('drops a bond the scan reported before the first connect', async () => {
  const { connect } = await load();
  plugin.connect.mockResolvedValue(undefined);
  tauriInvoke.mockResolvedValue(true);

  await connect('AA:BB', undefined, { bonded: true });
  expect(tauriInvoke).toHaveBeenCalledTimes(1);
  expect(tauriInvoke.mock.invocationCallOrder[0]).toBeLessThan(plugin.connect.mock.invocationCallOrder[0]);
});
