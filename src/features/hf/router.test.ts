/**
 * Transport selection for chat completions.
 *
 * The Space proxy is the default path, with the direct HF router kept as an
 * automatic fallback. Which failures cross that line is the whole contract:
 * fall back too eagerly and every rate limit silently starts billing the
 * user; fall back too late and a sleeping Space takes persona authoring down
 * with it. These tests pin each case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const notifyHfTokenInvalid = vi.fn();

const STICKER_URL = 'https://sticker.example.test';
const SPACE_URL = `${STICKER_URL}/api/chat/completions`;
const ROUTER_URL = 'https://router.huggingface.co/v1/chat/completions';

function response(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => (body ? JSON.parse(body) : {}),
  } as Response;
}

async function loadRouter(backend: 'space' | 'router') {
  vi.resetModules();
  vi.doMock('@tauri-apps/plugin-http', () => ({ fetch: fetchMock }));
  vi.doMock('@/shared/env', () => ({
    TEXT_GEN_BACKEND: backend,
    STICKER_API_URL: STICKER_URL,
    HF_MODEL_CHAIN: ['fallback/model'],
    HF_ROUTER_POLICY: 'preferred',
  }));
  vi.doMock('@/features/auth/tokenInvalidation', () => ({ notifyHfTokenInvalid }));
  // Catalog discovery is a separate concern (and a network call); keep the
  // direct-router path offline and optimistic here.
  vi.doMock('./models', () => ({
    fetchModelCatalog: async () => new Map(),
    modelSupportsStructuredOutput: () => true,
    pruneToLive: (models: string[]) => models,
  }));
  return import('./router');
}

/** Minimal call the callers make (`generate.ts`, `sticker-avatar.ts`). */
const CHAT = {
  baseModel: 'Qwen/Qwen2.5-7B-Instruct',
  hfToken: 'hf-user-token',
  body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 },
};

function calledUrls(): string[] {
  return fetchMock.mock.calls.map(call => (call as [string])[0]);
}

beforeEach(() => {
  fetchMock.mockReset();
  notifyHfTokenInvalid.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@tauri-apps/plugin-http');
  vi.doUnmock('@/shared/env');
  vi.doUnmock('@/features/auth/tokenInvalidation');
  vi.doUnmock('./models');
  vi.resetModules();
});

describe('space transport', () => {
  it('posts to the Space proxy and never touches the router on success', async () => {
    fetchMock.mockResolvedValue(response(200));
    const { routerChatCompletion } = await loadRouter('space');

    const res = await routerChatCompletion(CHAT);

    expect(res.status).toBe(200);
    expect(calledUrls()).toEqual([SPACE_URL]);
  });

  it('lets the proxy pick the model and passes the user token as bearer', async () => {
    fetchMock.mockResolvedValue(response(200));
    const { routerChatCompletion } = await loadRouter('space');

    await routerChatCompletion(CHAT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer hf-user-token');
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ max_tokens: 10 });
    // Our `baseModel` is an HF id; the proxy runs on fal/OpenRouter ids and
    // would reject it. Model choice is the Space's business.
    expect(sent).not.toHaveProperty('model');
  });

  it('still pins the preferred model on the router fallback', async () => {
    fetchMock
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));
    const { routerChatCompletion } = await loadRouter('space');

    await routerChatCompletion(CHAT);

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe(
      'Qwen/Qwen2.5-7B-Instruct:preferred',
    );
  });

  it('forwards structured output so the proxy can ask for JSON schema', async () => {
    fetchMock.mockResolvedValue(response(200));
    const { routerChatCompletion } = await loadRouter('space');

    await routerChatCompletion({
      ...CHAT,
      structuredOutput: { name: 'persona', schema: { type: 'object' } },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'persona', strict: true },
    });
  });
});

describe('space transport fallback', () => {
  it.each([
    ['a sleeping / crashed Space', 503],
    ['an unexpected backend error', 500],
    ['a Space without the route deployed yet', 404],
    // What an older Space actually answers: its StaticFiles mount at `/`
    // swallows the unknown path and rejects the POST as Method Not Allowed.
    ['a Space whose static mount swallowed the POST', 405],
  ])('falls back to the router on %s', async (_label, status) => {
    fetchMock
      .mockResolvedValueOnce(response(status, 'boom'))
      .mockResolvedValueOnce(response(200));
    const { routerChatCompletion } = await loadRouter('space');

    const res = await routerChatCompletion(CHAT);

    expect(res.status).toBe(200);
    expect(calledUrls()).toEqual([SPACE_URL, ROUTER_URL]);
  });

  it('falls back when the Space is unreachable at the transport level', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(response(200));
    const { routerChatCompletion } = await loadRouter('space');

    await routerChatCompletion(CHAT);

    expect(calledUrls()).toEqual([SPACE_URL, ROUTER_URL]);
  });

  it('pays for the fallback with the user token', async () => {
    fetchMock
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));
    const { routerChatCompletion } = await loadRouter('space');

    await routerChatCompletion(CHAT);

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer hf-user-token',
    );
  });
});

describe('space transport hard failures', () => {
  it('surfaces a rejected request without retrying on the user tab', async () => {
    fetchMock.mockResolvedValue(response(400, 'Model x is not available here'));
    const { routerChatCompletion, HfRouterError } = await loadRouter('space');

    await expect(routerChatCompletion(CHAT)).rejects.toBeInstanceOf(HfRouterError);
    expect(calledUrls()).toEqual([SPACE_URL]);
  });

  it('keeps the Space rate limit meaningful instead of billing the user', async () => {
    fetchMock.mockResolvedValue(response(429, 'Rate limit exceeded'));
    const { routerChatCompletion } = await loadRouter('space');

    await expect(routerChatCompletion(CHAT)).rejects.toMatchObject({
      overloaded: true,
    });
    expect(calledUrls()).toEqual([SPACE_URL]);
  });

  it('evicts the token on a 401 from HF access control', async () => {
    fetchMock.mockResolvedValue(response(401, 'Invalid credentials'));
    const { routerChatCompletion } = await loadRouter('space');

    await expect(routerChatCompletion(CHAT)).rejects.toMatchObject({
      authInvalid: true,
    });
    expect(notifyHfTokenInvalid).toHaveBeenCalledTimes(1);
    expect(calledUrls()).toEqual([SPACE_URL]);
  });
});

describe('router transport', () => {
  it('skips the proxy entirely when configured for the direct router', async () => {
    fetchMock.mockResolvedValue(response(200));
    const { routerChatCompletion } = await loadRouter('router');

    await routerChatCompletion(CHAT);

    expect(calledUrls()).toEqual([ROUTER_URL]);
  });
});
