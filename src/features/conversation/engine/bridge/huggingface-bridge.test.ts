import { beforeEach, describe, expect, it, vi } from 'vitest';

const realtimeMock = vi.hoisted(() => ({
  clients: [] as Array<{
    emit: (event: string, detail: unknown) => void;
    listeners: Record<string, Array<(detail: unknown) => void>>;
    options: Record<string, unknown>;
    replaceInputTrack: (track: unknown) => void;
  }>,
  connectImpl: vi.fn(),
  closeImpl: vi.fn(),
  replaceInputTrackImpl: vi.fn(),
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

    replaceInputTrack(track: unknown): void {
      realtimeMock.replaceInputTrackImpl(track);
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
    realtimeMock.replaceInputTrackImpl.mockReset();
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

  // The SDK's auto re-dial swaps the whole RTCPeerConnection. The mic
  // track we were reading is a receiver of the OLD one, so it goes dead
  // silently - `onaudioprocess` keeps firing on a dead track and the
  // conversation looks connected while the backend hears nothing.
  // `rebindRobotAudio` is what re-reads it; without the swap below being
  // detected, the orb parks on `listening` forever.
  describe('rebindRobotAudio after an SDK re-dial', () => {
    const audioTrack = (id: string): MediaStreamTrack =>
      ({ id, kind: 'audio', enabled: true }) as unknown as MediaStreamTrack;

    /** Robot stub whose `peerConnection` can be swapped, like a re-dial does. */
    function makeRobot(track: MediaStreamTrack) {
      const robot = {
        peerConnection: {
          getReceivers: () => [{ track }],
          getTransceivers: () => [],
        },
      };
      return {
        robot,
        swapPeerConnection(next: MediaStreamTrack) {
          robot.peerConnection = {
            getReceivers: () => [{ track: next }],
            getTransceivers: () => [],
          };
        },
      };
    }

    async function connectedBridge(first: MediaStreamTrack) {
      realtimeMock.connectImpl.mockResolvedValue(undefined);
      const { robot, swapPeerConnection } = makeRobot(first);
      const bridge = createHuggingFaceBridge({
        getRobot: () => robot as never,
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
      await bridge.connect(first);
      return { bridge, robot, swapPeerConnection };
    }

    it("re-points the uplink at the new peer connection's receiver", async () => {
      const before = audioTrack('mic-before');
      const after = audioTrack('mic-after');
      const { bridge, robot, swapPeerConnection } = await connectedBridge(before);

      swapPeerConnection(after);
      expect(bridge.rebindRobotAudio(robot as never)).toBe(true);

      expect(realtimeMock.replaceInputTrackImpl).toHaveBeenCalledWith(after);
    });

    it('keeps the mute state on the replacement track', async () => {
      const before = audioTrack('mic-before');
      const after = audioTrack('mic-after');
      const { bridge, robot, swapPeerConnection } = await connectedBridge(before);

      bridge.setMicMuted(true);
      swapPeerConnection(after);
      bridge.rebindRobotAudio(robot as never);

      expect(after.enabled).toBe(false);
    });

    it('reports failure when the new connection has no audio receiver', async () => {
      const before = audioTrack('mic-before');
      const { bridge, robot } = await connectedBridge(before);
      (robot as { peerConnection: unknown }).peerConnection = {
        getReceivers: () => [],
        getTransceivers: () => [],
      };

      expect(bridge.rebindRobotAudio(robot as never)).toBe(false);
      expect(realtimeMock.replaceInputTrackImpl).not.toHaveBeenCalled();
    });
  });
});
