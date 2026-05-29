import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));

import {
  buildHfSessionConfig,
  normalizeHfRealtimeWebSocketUrl,
  parseHfRealtimeUrl,
} from './huggingface-realtime';

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
