/**
 * Realtime backend controller.
 *
 * Owns the LIVE realtime bridge instance and keeps it matching the
 * user-selected provider. The bridge is provider-specific (HF realtime
 * vs OpenAI realtime) and is built through `createRealtimeBackend`;
 * switching provider in the conversation settings only takes effect by
 * swapping the concrete bridge, which is what `ensureSelection()` does.
 *
 * It also owns the vision side-channel wiring, because vision attaches
 * to the bridge's `RealtimePort` and that port dies with the bridge on
 * a swap. Keeping both here means the re-wire happens in exactly one
 * place, atomically with the swap - the engine can't forget to do it.
 *
 * What it deliberately does NOT own:
 *   - the conversation lifecycle (`connect` / `close` are driven by the
 *     engine's bring-up / teardown, on the bridge this exposes);
 *   - the bridge deps (engine closures - voice, prompt, tools, status
 *     callbacks - passed straight through);
 *   - the vision internals (the engine supplies an `attachVision`
 *     callback closing over its video cache + token reader).
 *
 * The controller is pure orchestration over those: build, swap-on-
 * change, re-wire vision, dispose.
 */
import { createRealtimeBackend } from "./index";
import type {
  RealtimeBackend,
  RealtimeBackendDeps,
  RealtimeBackendKind,
} from "./types";
import type { VisionHandle } from "../../vision";

export interface RealtimeBackendControllerDeps {
  /** The provider the next (re)build targets. Read at construction and
   *  again on every `ensureSelection()` so a settings switch is picked
   *  up at the next conversation start. */
  getSelectedKind: () => RealtimeBackendKind;
  /** Provider-agnostic deps forwarded to the bridge factory. The same
   *  object is reused across swaps (its getters are all lazy). */
  bridgeDeps: RealtimeBackendDeps;
  /** Wire the vision side-channel onto a freshly built bridge. Called
   *  once at construction and again after every swap (the previous
   *  handle is disposed first). Returns null when vision is inert (no
   *  HF token). */
  attachVision: (bridge: RealtimeBackend) => VisionHandle | null;
  /** Bridge factory. Defaults to the real `createRealtimeBackend`;
   *  injectable so the swap logic is testable without module mocks. */
  buildBridge?: (
    kind: RealtimeBackendKind,
    deps: RealtimeBackendDeps,
  ) => RealtimeBackend;
}

export interface RealtimeBackendController {
  /** The live bridge. Identity is stable between swaps. */
  bridge: () => RealtimeBackend;
  /** Vision handle bound to the live bridge, or null when inert. */
  vision: () => VisionHandle | null;
  /** Rebuild the bridge + re-wire vision when the selected provider
   *  changed since the last build. No-op when it still matches.
   *  Closes the previous bridge first (expected to be idle at swap
   *  time, since the settings cog is stopped-only). */
  ensureSelection: () => Promise<void>;
  /** Terminal vision teardown (engine unmount). The bridge's own close
   *  stays with the engine's teardown path. */
  disposeVision: () => void;
}

export function createRealtimeBackendController(
  deps: RealtimeBackendControllerDeps,
): RealtimeBackendController {
  const build = deps.buildBridge ?? createRealtimeBackend;

  let kind = deps.getSelectedKind();
  let bridge = build(kind, deps.bridgeDeps);
  let vision = deps.attachVision(bridge);

  const ensureSelection = async (): Promise<void> => {
    const selected = deps.getSelectedKind();
    if (selected === kind) return;

    // The bridge is idle at swap time (the conversation-settings cog is
    // stopped-only), so `close()` just releases its idle resources.
    try {
      await bridge.close();
    } catch (err) {
      console.warn(
        "[backend-controller] closing previous backend failed:",
        err,
      );
    }
    vision?.dispose();

    kind = selected;
    bridge = build(selected, deps.bridgeDeps);
    vision = deps.attachVision(bridge);
  };

  return {
    bridge: () => bridge,
    vision: () => vision,
    ensureSelection,
    disposeVision: () => {
      vision?.dispose();
    },
  };
}
