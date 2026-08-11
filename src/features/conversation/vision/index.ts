/**
 * Vision module · public façade.
 *
 * The single attach point the conversation engine talks to. Two
 * exports:
 *
 *   - `attachVision(deps)` wires the frame capture to the live
 *     `RealtimePort` and returns a `VisionHandle` exposing a single
 *     on-demand `look()` (backing the realtime `look` tool).
 *   - `getVisionPromptAppendix()` returns the system-prompt fragment
 *     the engine concatenates into `composeInstructions()`.
 *
 * There is NO passive/periodic capture: the camera is read only when
 * the model deliberately calls the `look` tool (i.e. the user asked it
 * to look at something). Nothing is captured otherwise.
 *
 * How a `look` works
 * ------------------
 * The S2S realtime backend is natively multimodal, so we send it the
 * ACTUAL photo instead of a text description from a separate VLM:
 *
 *   1. capture a JPEG frame from the robot's WebRTC video stream;
 *   2. attach it to the conversation as an `input_image` user item
 *      (`conversation.item.create` on the realtime data channel);
 *   3. return an "image attached" tool result; the engine's
 *      `sendToolResponse` then fires the `function_call_output` +
 *      `response.create` pair and the model answers from the image.
 *
 * This mirrors the on-robot conversation app's `camera` tool flow
 * (`reachy_mini_conversation_app/.../huggingface_realtime.py`). No
 * extra credential, billing tier, or gated-model acceptance is
 * involved: the image rides the same session as the voice.
 */

import { captureFrame } from "./frame-capture";
import type { RealtimePort } from "../engine/realtime/types";
import type { LookResult } from "./types";

export interface VisionHandle {
  /** Terminal release. After this, `look()` returns a graceful
   *  failure instead of capturing. Idempotent. */
  dispose: () => void;
  /** On-demand capture for the realtime `look` tool: snapshots the
   *  camera and attaches the image to the conversation so the model
   *  can answer "what do you see?" within the same turn. Never
   *  throws - failures come back as `{ ok: false, message }`. */
  look: () => Promise<LookResult>;
}

export interface AttachVisionDeps {
  /** Side-channel port onto the live realtime websocket.
   *  Obtained from `realtimeBridge.getRealtimePort()`. Used to attach
   *  the captured frame to the conversation as an `input_image` item. */
  realtime: RealtimePort;
  /** Live accessor onto the robot's WebRTC video stream. Returning
   *  `null` makes `look()` fail gracefully (camera not live yet). */
  getVideoStream: () => MediaStream | null;
}

/**
 * Construct the vision pipeline. Returns a handle the engine exposes
 * to the `look` tool. There is no lifecycle to drive (no timers, no
 * subscriptions) - `look()` is invoked on demand and `dispose()` is
 * called on teardown.
 */
export function attachVision(deps: AttachVisionDeps): VisionHandle {
  let disposed = false;

  // Guard against parallel `look()` calls (the model double-firing the
  // tool): the second await piggybacks on the first's result instead
  // of capturing + attaching a second image.
  let inFlightLook: Promise<LookResult> | null = null;

  const look = (): Promise<LookResult> => {
    if (disposed) {
      return Promise.resolve({
        ok: false,
        message: "vision is not available in this session",
      });
    }
    if (inFlightLook) return inFlightLook;
    const run = doLook().finally(() => {
      inFlightLook = null;
    });
    inFlightLook = run;
    return run;
  };

  const doLook = async (): Promise<LookResult> => {
    const stream = deps.getVideoStream();
    if (!stream) {
      console.warn("[vision] look: no video stream available");
      return {
        ok: false,
        message:
          "Vision failed: no live camera feed from the robot right now. " +
          "Tell the user you can't see at the moment and offer to try again.",
      };
    }

    try {
      const frame = await captureFrame(stream);
      deps.realtime.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: frame.dataUrl }],
        },
      });
      console.info(
        `[vision] look: attached camera frame (${frame.widthPx}x${frame.heightPx})`,
      );
      return {
        ok: true,
        message:
          "Camera image captured and attached to the conversation. " +
          "Answer from what you actually see in that image.",
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn("[vision] look: capture failed:", reason);
      return {
        ok: false,
        message:
          `Vision failed: ${reason}. ` +
          "Tell the user you couldn't get a clear look just now and " +
          "offer to try again, rather than guessing what you saw.",
      };
    }
  };

  return {
    dispose: () => {
      disposed = true;
    },
    look,
  };
}

export { getVisionPromptAppendix } from "./prompt-fragment";
