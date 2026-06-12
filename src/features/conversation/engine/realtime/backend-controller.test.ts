import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createRealtimeBackendController } from './backend-controller';
import type { RealtimeBackend, RealtimeBackendDeps, RealtimeBackendKind } from './types';
import type { VisionHandle } from '../../vision';

/** Minimal `RealtimeBackend` stub: only `close()` matters to the
 *  controller, the rest are inert spies so the contract type-checks. */
function makeBridge(kind: RealtimeBackendKind): RealtimeBackend & { kind: RealtimeBackendKind } {
  return {
    kind,
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    sendToolResponse: vi.fn(() => true),
    isReconnecting: vi.fn(() => false),
    resetReconnectCounter: vi.fn(),
    getRobotMicTrack: vi.fn(() => null),
    setMicMuted: vi.fn(),
    getRealtimePort: vi.fn(() => ({ sendEvent: vi.fn(), onUserTranscript: vi.fn(() => () => {}) })),
  };
}

function makeVision(): VisionHandle & { dispose: ReturnType<typeof vi.fn> } {
  return {
    dispose: vi.fn(),
    look: vi.fn(async () => ({ ok: true, message: 'ok', description: 'ok' })),
  };
}

const bridgeDeps = {} as RealtimeBackendDeps;

describe('createRealtimeBackendController', () => {
  let selected: RealtimeBackendKind;
  let buildBridge: ReturnType<typeof vi.fn>;
  let attachVision: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    selected = 'openai';
    // Each build returns a fresh bridge tagged with the requested kind.
    buildBridge = vi.fn((kind: RealtimeBackendKind) => makeBridge(kind));
    // Each attach returns a fresh vision handle so we can assert the
    // OLD one gets disposed on a swap.
    attachVision = vi.fn(() => makeVision());
  });

  function create() {
    return createRealtimeBackendController({
      getSelectedKind: () => selected,
      bridgeDeps,
      attachVision,
      buildBridge,
    });
  }

  it('builds the initial bridge for the selected provider and wires vision', () => {
    const controller = create();

    expect(buildBridge).toHaveBeenCalledTimes(1);
    expect(buildBridge).toHaveBeenCalledWith('openai', bridgeDeps);
    expect(attachVision).toHaveBeenCalledTimes(1);
    expect(attachVision).toHaveBeenCalledWith(controller.bridge());
    expect(controller.vision()).not.toBeNull();
  });

  it('is a no-op when the selection still matches the live bridge', async () => {
    const controller = create();
    const bridge = controller.bridge();

    await controller.ensureSelection();

    expect(controller.bridge()).toBe(bridge);
    expect(buildBridge).toHaveBeenCalledTimes(1);
    expect(attachVision).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the bridge and re-wires vision when the provider changed', async () => {
    const controller = create();
    const oldBridge = controller.bridge() as ReturnType<typeof makeBridge>;
    const oldVision = controller.vision() as ReturnType<typeof makeVision>;

    selected = 'huggingface';
    await controller.ensureSelection();

    // Old bridge closed, old vision disposed.
    expect(oldBridge.close).toHaveBeenCalledTimes(1);
    expect(oldVision.dispose).toHaveBeenCalledTimes(1);

    // Fresh bridge for the new provider, fresh vision attached to it.
    expect(buildBridge).toHaveBeenCalledTimes(2);
    expect(buildBridge).toHaveBeenLastCalledWith('huggingface', bridgeDeps);
    const newBridge = controller.bridge() as ReturnType<typeof makeBridge>;
    expect(newBridge).not.toBe(oldBridge);
    expect(newBridge.kind).toBe('huggingface');
    expect(attachVision).toHaveBeenCalledTimes(2);
    expect(attachVision).toHaveBeenLastCalledWith(newBridge);
  });

  it('swaps back and forth as the selection toggles', async () => {
    const controller = create();
    const kindOf = () => (controller.bridge() as ReturnType<typeof makeBridge>).kind;

    selected = 'huggingface';
    await controller.ensureSelection();
    expect(kindOf()).toBe('huggingface');

    selected = 'openai';
    await controller.ensureSelection();
    expect(kindOf()).toBe('openai');

    expect(buildBridge).toHaveBeenCalledTimes(3);
  });

  it('still swaps when the previous bridge fails to close', async () => {
    const controller = create();
    const oldBridge = controller.bridge() as ReturnType<typeof makeBridge>;
    (oldBridge.close as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    selected = 'huggingface';
    await controller.ensureSelection();

    expect((controller.bridge() as ReturnType<typeof makeBridge>).kind).toBe('huggingface');
    expect(attachVision).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('disposeVision tears down the live vision handle', () => {
    const controller = create();
    const vision = controller.vision() as ReturnType<typeof makeVision>;

    controller.disposeVision();

    expect(vision.dispose).toHaveBeenCalledTimes(1);
  });

  it('tolerates a null vision handle (inert / no token)', async () => {
    attachVision = vi.fn(() => null);
    const controller = create();

    expect(controller.vision()).toBeNull();
    selected = 'huggingface';
    await expect(controller.ensureSelection()).resolves.toBeUndefined();
    expect((controller.bridge() as ReturnType<typeof makeBridge>).kind).toBe('huggingface');
    controller.disposeVision();
  });
});
