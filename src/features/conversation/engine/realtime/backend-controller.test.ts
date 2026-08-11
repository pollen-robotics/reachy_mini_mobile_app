import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createRealtimeBackendController } from './backend-controller';
import type { RealtimeBackend, RealtimeBackendDeps } from './types';
import type { VisionHandle } from '../../vision';

/** Minimal `RealtimeBackend` stub: the controller only holds it and reads
 *  its `getRealtimePort` via `attachVision`, the rest are inert spies so
 *  the contract type-checks. */
function makeBridge(): RealtimeBackend {
  return {
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
    look: vi.fn(async () => ({ ok: true, message: 'ok' })),
  };
}

const bridgeDeps = {} as RealtimeBackendDeps;

describe('createRealtimeBackendController', () => {
  let buildBridge: ReturnType<typeof vi.fn>;
  let attachVision: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    buildBridge = vi.fn(() => makeBridge());
    attachVision = vi.fn(() => makeVision());
  });

  function create() {
    return createRealtimeBackendController({
      bridgeDeps,
      attachVision,
      buildBridge,
    });
  }

  it('builds the bridge once and wires vision onto it', () => {
    const controller = create();

    expect(buildBridge).toHaveBeenCalledTimes(1);
    expect(buildBridge).toHaveBeenCalledWith(bridgeDeps);
    expect(attachVision).toHaveBeenCalledTimes(1);
    expect(attachVision).toHaveBeenCalledWith(controller.bridge());
    expect(controller.vision()).not.toBeNull();
  });

  it('exposes a stable bridge identity', () => {
    const controller = create();
    expect(controller.bridge()).toBe(controller.bridge());
  });

  it('disposeVision tears down the live vision handle', () => {
    const controller = create();
    const vision = controller.vision() as ReturnType<typeof makeVision>;

    controller.disposeVision();

    expect(vision.dispose).toHaveBeenCalledTimes(1);
  });

  it('tolerates a null vision handle (inert / no token)', () => {
    attachVision = vi.fn(() => null);
    const controller = create();

    expect(controller.vision()).toBeNull();
    expect(() => controller.disposeVision()).not.toThrow();
  });
});
