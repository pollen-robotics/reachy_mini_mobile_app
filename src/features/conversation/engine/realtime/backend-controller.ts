/**
 * Realtime backend controller.
 *
 * Owns the LIVE realtime bridge instance (the Hugging Face realtime
 * bridge) and the vision side-channel wired onto it. There is a single
 * realtime backend, so the controller no longer selects or swaps
 * providers - it builds the bridge once and keeps vision attached to it.
 *
 * It still owns the vision wiring (rather than the engine) because vision
 * attaches to the bridge's `RealtimePort`: keeping the build + the
 * attach in one place means the engine can't forget to wire it.
 *
 * What it deliberately does NOT own:
 *   - the conversation lifecycle (`connect` / `close` are driven by the
 *     engine's bring-up / teardown, on the bridge this exposes);
 *   - the bridge deps (engine closures - voice, prompt, tools, status
 *     callbacks - passed straight through);
 *   - the vision internals (the engine supplies an `attachVision`
 *     callback closing over its video cache + token reader).
 */
import { createHuggingFaceBridge } from "../bridge/huggingface-bridge";
import { readHfTokenFromStorage } from "../hf-token";
import type { RealtimeBackend, RealtimeBackendDeps } from "./types";
import type { VisionHandle } from "../../vision";

export interface RealtimeBackendControllerDeps {
  /** Provider-agnostic deps forwarded to the bridge. Its getters are all
   *  lazy, so a personality / language / tool change is picked up at the
   *  next conversation start without rebuilding the bridge. */
  bridgeDeps: RealtimeBackendDeps;
  /** Wire the vision side-channel onto the built bridge. Returns null
   *  when vision is inert (no HF token). */
  attachVision: (bridge: RealtimeBackend) => VisionHandle | null;
  /** Bridge factory. Defaults to the real Hugging Face bridge;
   *  injectable so the controller is testable without module mocks. */
  buildBridge?: (deps: RealtimeBackendDeps) => RealtimeBackend;
}

export interface RealtimeBackendController {
  /** The live bridge. Stable identity for the controller's lifetime. */
  bridge: () => RealtimeBackend;
  /** Vision handle bound to the live bridge, or null when inert. */
  vision: () => VisionHandle | null;
  /** Terminal vision teardown (engine unmount). The bridge's own close
   *  stays with the engine's teardown path. */
  disposeVision: () => void;
}

/** Default bridge builder: the Hugging Face realtime bridge with the
 *  user's stored HF token injected as its provider auth. */
function buildHuggingFaceBridge(deps: RealtimeBackendDeps): RealtimeBackend {
  return createHuggingFaceBridge({ ...deps, getHfToken: readHfTokenFromStorage });
}

export function createRealtimeBackendController(
  deps: RealtimeBackendControllerDeps,
): RealtimeBackendController {
  const build = deps.buildBridge ?? buildHuggingFaceBridge;

  const bridge = build(deps.bridgeDeps);
  const vision = deps.attachVision(bridge);

  return {
    bridge: () => bridge,
    vision: () => vision,
    disposeVision: () => {
      vision?.dispose();
    },
  };
}
