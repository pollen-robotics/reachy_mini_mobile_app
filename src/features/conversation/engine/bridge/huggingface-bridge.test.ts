import { beforeEach, describe, expect, it, vi } from 'vitest';

const realtimeMock = vi.hoisted(() => ({
  clients: [] as Array<{
    emit: (event: string, detail: unknown) => void;
    listeners: Record<string, Array<(detail: unknown) => void>>;
    options: Record<string, unknown>;
  }>,
  connectImpl: vi.fn(),
  closeImpl: vi.fn(),
}));

vi.mock('../huggingface-realtime', () => {
  class HuggingFaceRealtimeClient {
    listeners: Record<string, Array<(detail: unknown) => void>> = {};
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      realtimeMock.clients.push(this);
    }

    on(event: string, listener: (detail: unknown) => void): () => void {
      this.listeners[event] ??= [];
      this.listeners[event].push(listener);
      return () => {
        this.listeners[event] = this.listeners[event].filter(
          (candidate) => candidate !== listener,
        );
      };
    }

    emit(event: string, detail: unknown): void {
      for (const listener of this.listeners[event] ?? []) listener(detail);
    }

    connect(): Promise<void> {
      return realtimeMock.connectImpl(this);
    }

    close(): Promise<void> {
      return realtimeMock.closeImpl(this);
    }

    sendEvent(): void {
      // ignored
    }

    sendToolResponse(): void {
      // ignored
    }
  }

  return { HuggingFaceRealtimeClient };
});

import { createHuggingFaceBridge } from './huggingface-bridge';

describe('createHuggingFaceBridge', () => {
  beforeEach(() => {
    realtimeMock.clients = [];
    realtimeMock.connectImpl.mockReset();
    realtimeMock.closeImpl.mockReset();
    realtimeMock.closeImpl.mockResolvedValue(undefined);
  });

  it('leaves initial websocket failures recoverable by the caller', async () => {
    const failure = new Error('allocator failed');
    realtimeMock.connectImpl.mockImplementationOnce(async (client) => {
      client.emit('status', { status: 'error' });
      throw failure;
    });

    const onFatalError = vi.fn();
    const onReconnecting = vi.fn();
    const bridge = createHuggingFaceBridge({
      getRobot: () => null,
      getRobotHardwareId: () => 'hardware-123',
      getHfToken: () => 'hf-token',
      voice: 'Aiden',
      transcriptionLanguage: 'en',
      composeInstructions: () => 'Be concise.',
      onStatus: vi.fn(),
      onOutputTrack: vi.fn(),
      onToolCall: vi.fn(),
      onReconnecting,
      onFatalError,
    });

    await expect(bridge.connect({} as MediaStreamTrack)).rejects.toThrow(
      'allocator failed',
    );
    expect(onReconnecting).not.toHaveBeenCalled();
    expect(onFatalError).not.toHaveBeenCalled();
  });

  it('snapshots the stable hardware id when it builds a realtime client', async () => {
    realtimeMock.connectImpl.mockResolvedValue(undefined);
    const bridge = createHuggingFaceBridge({
      getRobot: () => null,
      getRobotHardwareId: () => 'hardware-123',
      getHfToken: () => 'hf-token',
      voice: 'Aiden',
      transcriptionLanguage: 'en',
      composeInstructions: () => 'Be concise.',
      onStatus: vi.fn(),
      onOutputTrack: vi.fn(),
      onToolCall: vi.fn(),
      onReconnecting: vi.fn(),
      onFatalError: vi.fn(),
    });

    await bridge.connect({} as MediaStreamTrack);

    expect(realtimeMock.clients[0].options).toMatchObject({
      hardwareId: 'hardware-123',
    });
  });
});
