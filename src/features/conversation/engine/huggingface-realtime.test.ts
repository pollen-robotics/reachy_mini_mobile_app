import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));

import {
  buildHfSessionConfig,
  HuggingFaceRealtimeClient,
  normalizeHfRealtimeWebSocketUrl,
  parseHfRealtimeUrl,
} from './huggingface-realtime';

const fetchMock = vi.mocked(tauriFetch);

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: string[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  dispatchClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    const event = Object.assign(new Event('close'), { code, reason });
    this.dispatchEvent(event);
  }
}

class FakeAudioContext {
  readonly sampleRate: number;
  readonly state = 'running';
  readonly currentTime = 0;
  readonly destination = {};

  constructor(options?: AudioContextOptions) {
    this.sampleRate = options?.sampleRate ?? 48_000;
  }

  createMediaStreamDestination(): Pick<MediaStreamAudioDestinationNode, 'stream'> {
    return {
      stream: {
        getAudioTracks: () => [makeTrack()],
      } as unknown as MediaStream,
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function makeTrack(): MediaStreamTrack {
  return { stop: vi.fn() } as unknown as MediaStreamTrack;
}

function installRealtimeBrowserFakes(): void {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe('parseHfRealtimeUrl', () => {
  it('keeps allocator session query params and drops model params', () => {
    const parsed = parseHfRealtimeUrl(
      'ws://127.0.0.1:8765/v1/realtime?session_token=abc&model=ignored',
    );

    expect(parsed.websocketUrl).toBe(
      'ws://127.0.0.1:8765/v1/realtime?session_token=abc',
    );
    expect(parsed.websocketBaseUrl).toBe('ws://127.0.0.1:8765/v1');
    expect(parsed.connectQuery).toEqual({ session_token: 'abc' });
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.port).toBe(8765);
    expect(parsed.hasRealtimePath).toBe(true);
  });

  it('normalizes https allocator URLs to wss websocket URLs', () => {
    expect(
      normalizeHfRealtimeWebSocketUrl(
        'https://hf.example.test/v1/realtime?session_token=allocated',
      ),
    ).toBe('wss://hf.example.test/v1/realtime?session_token=allocated');
  });
});

describe('HuggingFaceRealtimeClient', () => {
  it('rejects startup when the websocket closes before opening', async () => {
    installRealtimeBrowserFakes();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        connect_url: 'ws://127.0.0.1:8765/v1/realtime?session_token=bad',
      }),
      text: async () => '',
    } as Response);

    const client = new HuggingFaceRealtimeClient({
      getHfToken: () => '',
      voice: 'Aiden',
      instructions: 'Be concise.',
      inputTrack: makeTrack(),
    });
    const statuses: string[] = [];
    client.on('status', ({ status }) => statuses.push(status));

    const connectPromise = client.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0].dispatchClose(4401, 'bad session');

    await expect(connectPromise).rejects.toThrow(
      'Hugging Face realtime websocket closed (4401): bad session',
    );
    expect(statuses).toContain('error');
  });
});

describe('buildHfSessionConfig', () => {
  it('builds the native PCM session config expected by the HF backend', () => {
    const config = buildHfSessionConfig({
      instructions: 'Be concise.',
      voice: 'serena',
      tools: [
        {
          name: 'move_head',
          description: 'Move the head.',
          parameters: { type: 'object', properties: {} },
        },
      ],
    });

    expect(config).toMatchObject({
      type: 'realtime',
      instructions: 'Be concise.',
      tool_choice: 'auto',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: null },
          turn_detection: {
            type: 'server_vad',
            interrupt_response: true,
          },
        },
        output: {
          format: { type: 'audio/pcm', rate: null },
          voice: 'Serena',
        },
      },
      tools: [
        {
          type: 'function',
          name: 'move_head',
          description: 'Move the head.',
          parameters: { type: 'object', properties: {} },
        },
      ],
    });
    const audioInput = (config.audio as { input: Record<string, unknown> }).input;
    expect(audioInput).not.toHaveProperty('transcription');
  });

  it('falls back to the default HF voice for unsupported saved voices', () => {
    const config = buildHfSessionConfig({
      instructions: '',
      voice: 'cedar',
      tools: [],
    });

    expect(config).toMatchObject({
      audio: {
        output: {
          voice: 'Aiden',
        },
      },
    });
  });
});
