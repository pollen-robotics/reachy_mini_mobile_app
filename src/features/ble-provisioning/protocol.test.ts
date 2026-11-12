/**
 * Wi-Fi scan parsing for the setup wizard's network list.
 */
import { beforeEach, expect, it, vi } from 'vitest';

const sendCommand = vi.fn();

async function load() {
  vi.resetModules();
  vi.doMock('@/features/ble/bleWifi', () => ({ sendCommand }));
  return (await import('./protocol')).scanWifi;
}

beforeEach(() => {
  sendCommand.mockReset();
});

it("hides robot hotspots, which are never a network to join", async () => {
  sendCommand.mockResolvedValue('["SFR_39A0","SFR_39A0_5GHZ","reachy-mini-ap"]');
  const scanWifi = await load();
  await expect(scanWifi()).resolves.toEqual(['SFR_39A0', 'SFR_39A0_5GHZ']);
});
