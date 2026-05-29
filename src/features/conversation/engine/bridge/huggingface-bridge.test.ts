import { beforeEach, describe, expect, it, vi } from 'vitest';

const realtimeMock = vi.hoisted(() => ({
  clients: [] as Array<{
    emit: (event: string, detail: unknown) => void;
    listeners: Record<string, Array<(detail: unknown) => void>>;
  }>,
  connectImpl: vi.fn(),
  closeImpl: vi.fn(),
}));

vi.mock('../huggingface-realtime', () => {
  class HuggingFaceRealtimeClient {
    listeners: Record<string, Array<(detail: unknown) => void>> = {};

    constructor() {
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
      getHfToken: () => 'hf-token',
      voice: 'Aiden',
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
});
