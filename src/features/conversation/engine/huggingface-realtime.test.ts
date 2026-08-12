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

function makeFakeAudioNode(): Record<string, unknown> {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: { value: 1 },
    onaudioprocess: null,
  };
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

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return makeFakeAudioNode() as unknown as MediaStreamAudioSourceNode;
  }

  createScriptProcessor(): ScriptProcessorNode {
    return makeFakeAudioNode() as unknown as ScriptProcessorNode;
  }

  createGain(): GainNode {
    return makeFakeAudioNode() as unknown as GainNode;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeMediaStream {
  constructor(_tracks?: unknown[]) {}
}

function makeTrack(): MediaStreamTrack {
  return { stop: vi.fn() } as unknown as MediaStreamTrack;
}

function installRealtimeBrowserFakes(): void {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaStream', FakeMediaStream);
}

function dispatchServerEvent(
  ws: FakeWebSocket,
  payload: Record<string, unknown>,
): void {
  ws.dispatchEvent(
    Object.assign(new Event('message'), { data: JSON.stringify(payload) }),
  );
}

function sentEventsOfType(ws: FakeWebSocket, type: string): unknown[] {
  return ws.sent
    .map(raw => JSON.parse(raw) as { type?: string })
    .filter(evt => evt.type === type);
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

  describe('tool follow-up response.create retry', () => {
    async function connectedClient(): Promise<{
      client: HuggingFaceRealtimeClient;
      ws: FakeWebSocket;
    }> {
      installRealtimeBrowserFakes();
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          connect_url: 'ws://127.0.0.1:8765/v1/realtime?session_token=ok',
        }),
        text: async () => '',
      } as Response);

      const client = new HuggingFaceRealtimeClient({
        getHfToken: () => '',
        voice: 'Aiden',
        instructions: 'Be concise.',
        inputTrack: makeTrack(),
      });
      const connectPromise = client.connect();
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const ws = FakeWebSocket.instances[0];
      ws.readyState = FakeWebSocket.OPEN;
      ws.dispatchEvent(new Event('open'));
      await connectPromise;
      return { client, ws };
    }

    /** Runs a tool round-trip up to (and including) the server rejection. */
    function rejectedToolFollowUp(client: HuggingFaceRealtimeClient, ws: FakeWebSocket): void {
      dispatchServerEvent(ws, {
        type: 'response.function_call_arguments.done',
        call_id: 'call-1',
        name: 'look',
        arguments: '{}',
      });
      client.sendToolResponse('call-1', 'ok');
      expect(sentEventsOfType(ws, 'response.create')).toHaveLength(1);
      dispatchServerEvent(ws, {
        type: 'error',
        error: { code: 'conversation_already_has_active_response' },
      });
    }

    it('re-fires response.create once the racing response closes', async () => {
      const { client, ws } = await connectedClient();
      rejectedToolFollowUp(client, ws);

      // Not re-sent while the rejecting response is still active.
      expect(sentEventsOfType(ws, 'response.create')).toHaveLength(1);

      dispatchServerEvent(ws, { type: 'response.done' });
      expect(sentEventsOfType(ws, 'response.create')).toHaveLength(2);

      // One retry only: later response.done events must not re-answer.
      dispatchServerEvent(ws, { type: 'response.done' });
      expect(sentEventsOfType(ws, 'response.create')).toHaveLength(2);

      await client.close();
    });

    it('drops the retry when a new response starts on its own', async () => {
      const { client, ws } = await connectedClient();
      rejectedToolFollowUp(client, ws);

      // E.g. the user barged in and the server already opened a follow-up
      // response that sees the tool output: retrying would double-answer.
      dispatchServerEvent(ws, { type: 'response.created' });
      dispatchServerEvent(ws, { type: 'response.done' });
      expect(sentEventsOfType(ws, 'response.create')).toHaveLength(1);

      await client.close();
    });

    it('ignores the rejection outside a tool round-trip', async () => {
      const { client, ws } = await connectedClient();

      // Same error code, but no pending tool call (barge-in race): the old
      // swallow behaviour is the right one here.
      dispatchServerEvent(ws, {
        type: 'error',
        error: { code: 'conversation_already_has_active_response' },
      });
      dispatchServerEvent(ws, { type: 'response.done' });
      expect(sentEventsOfType(ws, 'response.create')).toHaveLength(0);

      await client.close();
    });
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
          transcription: { model: 'gpt-4o-transcribe', language: 'en' },
          turn_detection: {
            type: 'server_vad',
            interrupt_response: true,
            threshold: 0.6,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
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
    expect(audioInput).toHaveProperty('transcription');
  });

  it('defaults the transcription language to English when none is given', () => {
    const config = buildHfSessionConfig({
      instructions: '',
      voice: 'Aiden',
      tools: [],
    });
    expect(config).toMatchObject({
      audio: { input: { transcription: { language: 'en' } } },
    });
  });

  it('uses the provided transcription language', () => {
    const config = buildHfSessionConfig({
      instructions: '',
      voice: 'Aiden',
      tools: [],
      transcriptionLanguage: 'fr',
    });
    expect(config).toMatchObject({
      audio: { input: { transcription: { model: 'gpt-4o-transcribe', language: 'fr' } } },
    });
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
