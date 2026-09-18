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

async function load() {
  vi.resetModules();
  vi.doMock('@mnlphlp/plugin-blec', () => plugin);
  return import('./bleWifi');
}

beforeEach(() => {
  for (const fn of Object.values(plugin)) fn.mockReset();
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
