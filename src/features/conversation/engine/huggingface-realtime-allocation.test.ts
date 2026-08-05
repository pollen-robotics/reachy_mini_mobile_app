import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const ALLOCATOR_URL = 'https://allocator.example.test/session';
const CONNECT_URL = 'https://realtime.example.test/v1/realtime?session_token=allocated';

function response(status: number, payload: Record<string, unknown> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => '',
  } as Response;
}

async function loadRealtime(mode: 'deployed' | 'local') {
  vi.resetModules();
  vi.doMock('@tauri-apps/plugin-http', () => ({ fetch: fetchMock }));
  vi.doMock('@/shared/env', () => ({
    HF_REALTIME_CONNECTION_MODE: mode,
    HF_REALTIME_SESSION_PROXY_URL: ALLOCATOR_URL,
    HF_REALTIME_WS_URL: mode === 'local' ? 'ws://127.0.0.1:8765/v1/realtime' : null,
  }));
  return import('./huggingface-realtime');
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('@tauri-apps/plugin-http');
  vi.doUnmock('@/shared/env');
  vi.resetModules();
});

describe('HF realtime allocator request', () => {
  it('attributes deployed allocations without using standard Authorization', async () => {
    fetchMock.mockResolvedValue(
      response(200, { connect_url: CONNECT_URL, session_id: 'session-1' })
    );
    const { resolveHfRealtimeWebSocketUrl } = await loadRealtime('deployed');

    await expect(resolveHfRealtimeWebSocketUrl('hf-secret', 'hardware-123')).resolves.toBe(
      'wss://realtime.example.test/v1/realtime?session_token=allocated'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(ALLOCATOR_URL);
    expect(init.method).toBe('POST');
    expect(headers).toMatchObject({
      'Content-Type': 'application/json',
      'User-Agent': 'reachy-mini-mobile-app',
      'X-Reachy-Mini-Authorization': 'Bearer hf-secret',
    });
    expect(headers).not.toHaveProperty('Authorization');
    expect(init.body).toBe('{"hardware_id":"hardware-123"}');
  });

  it('sends an empty JSON object and still allocates without a hardware id', async () => {
    fetchMock.mockResolvedValue(response(200, { connect_url: CONNECT_URL }));
    const { resolveHfRealtimeWebSocketUrl } = await loadRealtime('deployed');

    await expect(resolveHfRealtimeWebSocketUrl('hf-secret', null)).resolves.toContain(
      '/v1/realtime'
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe('{}');
  });

  it('omits allocator authorization and still allocates without an HF token', async () => {
    fetchMock.mockResolvedValue(response(200, { connect_url: CONNECT_URL }));
    const { resolveHfRealtimeWebSocketUrl } = await loadRealtime('deployed');

    await expect(resolveHfRealtimeWebSocketUrl(null, 'hardware-123')).resolves.toContain(
      '/v1/realtime'
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('X-Reachy-Mini-Authorization');
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers['User-Agent']).toBe('reachy-mini-mobile-app');
  });

  it('bypasses allocation and exposes no stored identity in local mode', async () => {
    const { resolveHfRealtimeWebSocketUrl } = await loadRealtime('local');

    const url = await resolveHfRealtimeWebSocketUrl(
      'hf-must-stay-private',
      'hardware-must-stay-private'
    );

    expect(url).toBe('ws://127.0.0.1:8765/v1/realtime');
    expect(url).not.toContain('hf-must-stay-private');
    expect(url).not.toContain('hardware-must-stay-private');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reuses the same headers and JSON body on transient retries', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200, { connect_url: CONNECT_URL }));
    const { resolveHfRealtimeWebSocketUrl } = await loadRealtime('deployed');

    const allocation = resolveHfRealtimeWebSocketUrl('hf-secret', 'hardware-123');
    await vi.runAllTimersAsync();
    await expect(allocation).resolves.toContain('/v1/realtime');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstInit = fetchMock.mock.calls[0][1] as RequestInit;
    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(retryInit).toBe(firstInit);
    expect(retryInit.headers).toEqual(firstInit.headers);
    expect(retryInit.body).toBe(firstInit.body);
  });
});
