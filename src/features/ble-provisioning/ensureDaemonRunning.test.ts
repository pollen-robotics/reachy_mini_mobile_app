/**
 * The setup wizard's daemon nudge.
 *
 * A robot whose daemon was stopped (the desktop app does this on window close)
 * can never register on central, so account linking times out and only a reboot
 * recovers. These tests pin when we POST `/api/daemon/start` and when we leave
 * a healthy daemon alone.
 */
import { beforeEach, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

async function load() {
  vi.resetModules();
  vi.doMock('@tauri-apps/plugin-http', () => ({ fetch: fetchMock }));
  return (await import('./ensureDaemonRunning')).ensureDaemonRunning;
}

function startCalls(): string[] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter(url => url.includes('/api/daemon/start'));
}

beforeEach(() => {
  fetchMock.mockReset();
});

it('starts a stopped daemon', async () => {
  fetchMock.mockResolvedValue(response(200, { state: 'stopped' }));
  const ensureDaemonRunning = await load();

  await ensureDaemonRunning('192.168.0.90');

  expect(startCalls()).toEqual(['http://192.168.0.90:8000/api/daemon/start?wake_up=false']);
});

it.each(['running', 'starting'])('leaves a %s daemon alone', async state => {
  fetchMock.mockResolvedValue(response(200, { state }));
  const ensureDaemonRunning = await load();

  await ensureDaemonRunning('192.168.0.90');

  expect(startCalls()).toEqual([]);
});

it('stays quiet when the robot is unreachable', async () => {
  fetchMock.mockRejectedValue(new Error('network down'));
  const ensureDaemonRunning = await load();

  await expect(ensureDaemonRunning('192.168.0.90')).resolves.toBeUndefined();
  expect(startCalls()).toEqual([]);
});
