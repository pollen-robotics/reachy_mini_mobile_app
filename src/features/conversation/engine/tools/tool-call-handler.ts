/**
 * Tool-call handler.
 *
 * Owns the side of the engine that reacts to realtime tool
 * calls (`move_head`, `play_move`, `remember`, `forget`, …):
 *
 *   - Surfaces a friendly toast label via the host's
 *     `onToolToast` callback.
 *   - Forwards the action to the right downstream module (head
 *     pose, MovePlayer, memory store).
 *   - Reports the outcome back through `sendToolResponse()` so the
 *     model can chain.
 *
 * The handler also owns:
 *   - the lazily-created `MovePlayer` (one per session),
 *   - the `toolPoseRestoreTimer` that releases a tool-driven head
 *     pose after a short hold so the wobbler can resume.
 *
 * It signals choreography boundaries via `onMoveStart` /
 * `onMoveEnd` so the engine can pause the wobbler + antennas
 * oscillator while a move is playing (otherwise their 30 Hz writes
 * fight the recorded frames). The handler exposes a `stop()` method
 * the engine calls during teardown so any in-flight choreography
 * gets cleanly cancelled.
 */

import { memoryStore } from "../memory";
import { MovePlayer, MOVE_IDS, type MoveId } from "../../motion/move-player";
import { HEAD_POSES, type HeadPoseName } from "../tools";
import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";
import type { ConversationToolToastEvent } from "../types";

export interface ToolCallEvent {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallHandlerDeps {
  /** Live SDK accessor. The handler bails out if `null`. */
  getRobot: () => ReachyMiniInstance | null;
  /**
   * Send the tool result back through whatever bridge is currently
   * holding the realtime session. Returns `false` when there's no
   * live client (e.g. the engine raced a teardown), in which case
   * the handler swallows the result silently.
   *
   * Decoupled from the realtime client directly so the handler
   * doesn't have to know about the bridge's internals.
   */
  sendToolResponse: (
    callId: string,
    result: { ok: boolean; message: string },
  ) => boolean;
  /** Fires when a choreography starts. The engine pauses the
   *  wobbler / antennas oscillator so they don't fight the
   *  recorded frames. */
  onMoveStart: () => void;
  /** Fires when a choreography ends (or fails). The engine resumes
   *  the wobbler / antennas oscillator. */
  onMoveEnd: () => void;
  /** Forwarded host callback for the orb toast. The handler
   *  formats the label; the host owns the rendering / dismissal. */
  onToolToast?: (toast: ConversationToolToastEvent) => void;
}

export interface ToolCallHandler {
  handleToolCall: (event: ToolCallEvent) => Promise<void>;
  /** Stop any in-flight choreography and clear the pose-restore
   *  timer. Called from `teardown()` / `stopConversation()` /
   *  `releaseSessionKeepAwake()` so a session-end doesn't leave
   *  motion bookkeeping dangling. */
  stop: () => void;
  /** True while a `move_head` tool call is "holding" the head on a
   *  named pose (i.e. the restore timer is still pending). The
   *  wobbler reads this to skip its own 30 Hz writes so the head
   *  stays where the model put it. */
  isPoseLocked: () => boolean;
}

const TOOL_TOAST_DURATION_MS = 2800;
const HEAD_POSE_HOLD_MS = 1200;

export function createToolCallHandler(
  deps: ToolCallHandlerDeps,
): ToolCallHandler {
  let movePlayer: MovePlayer | null = null;
  let toolPoseRestoreTimer: number | null = null;

  const showToolToast = (text: string, durationMs = TOOL_TOAST_DURATION_MS): void => {
    if (!deps.onToolToast) return;
    try {
      deps.onToolToast({ label: text, durationMs });
    } catch (err) {
      console.warn("[tool-call-handler] onToolToast threw:", err);
    }
  };

  const applyToolHeadPose = (pose: {
    roll: number;
    pitch: number;
    yaw: number;
  }): void => {
    const robot = deps.getRobot();
    if (!robot) return;

    robot.setHeadRpyDeg(pose.roll, pose.pitch, pose.yaw);

    if (toolPoseRestoreTimer !== null) {
      clearTimeout(toolPoseRestoreTimer);
    }
    toolPoseRestoreTimer = window.setTimeout(() => {
      toolPoseRestoreTimer = null;
      // Don't hard-reset to 0,0,0 - the wobbler's next tick will
      // naturally take over from wherever we are. Just clear the
      // lock.
    }, HEAD_POSE_HOLD_MS);
  };

  const playMove = async (name: MoveId): Promise<void> => {
    const robot = deps.getRobot();
    if (!robot) return;
    movePlayer ??= new MovePlayer(robot);

    deps.onMoveStart();
    try {
      await movePlayer.play(name);
    } finally {
      deps.onMoveEnd();
      // Snap the antennas back to neutral so the next oscillator
      // tick has a clean starting point.
      robot.setAntennasDeg(0, 0);
    }
  };

  const handleToolCall = async (event: ToolCallEvent): Promise<void> => {
    const robot = deps.getRobot();
    if (!robot) return;

    const { callId, name, arguments: args } = event;

    // Surface the pending action immediately so there's no gap
    // between "Reachy says I'll dance" and the dance itself.
    showToolToast(describeToolCall(name, args));

    let result: { ok: boolean; message: string };
    switch (name) {
      case "move_head": {
        const direction = String(args.direction ?? "");
        if (direction in HEAD_POSES) {
          const pose = HEAD_POSES[direction as HeadPoseName];
          applyToolHeadPose(pose);
          result = { ok: true, message: `head moved to ${direction}` };
        } else {
          result = {
            ok: false,
            message:
              `unknown direction '${direction}'. ` +
              `Valid: ${Object.keys(HEAD_POSES).join(", ")}`,
          };
        }
        break;
      }
      case "play_move": {
        const moveName = String(args.name ?? "");
        if ((MOVE_IDS as readonly string[]).includes(moveName)) {
          try {
            await playMove(moveName as MoveId);
            result = { ok: true, message: `played move '${moveName}'` };
          } catch (err) {
            result = {
              ok: false,
              message:
                `failed to play '${moveName}': ` +
                (err instanceof Error ? err.message : String(err)),
            };
          }
        } else {
          result = {
            ok: false,
            message: `unknown move '${moveName}'. Valid: ${MOVE_IDS.join(", ")}`,
          };
        }
        break;
      }
      case "remember": {
        const fact = String(args.fact ?? "");
        const stored = memoryStore.add(fact);
        if (!stored) {
          result = {
            ok: false,
            message:
              "fact was empty or invalid; nothing was saved. Try again " +
              "with a single short sentence about the user.",
          };
        } else {
          // Echo the stored text back so the model can see exactly
          // what ended up in the memory (helps catch its own
          // hallucinated truncations and dedupe matches).
          result = {
            ok: true,
            message: `saved: "${stored.text}"`,
          };
        }
        break;
      }
      case "forget": {
        const query = String(args.query ?? "");
        const { removed, candidates } = memoryStore.forget({ query });
        if (!removed) {
          result = {
            ok: false,
            message: `no memory matched "${query}"; nothing was removed.`,
          };
        } else if (candidates.length > 1) {
          // Tell the model about the other near-matches so it can
          // ask the user "did you mean X or Y?" instead of silently
          // picking.
          const others = candidates
            .slice(1)
            .map((f) => `"${f.text}"`)
            .join(", ");
          result = {
            ok: true,
            message:
              `removed: "${removed.text}". Other facts also matched ` +
              `"${query}": ${others}. Ask the user before forgetting more.`,
          };
        } else {
          result = { ok: true, message: `removed: "${removed.text}"` };
        }
        break;
      }
      default:
        result = { ok: false, message: `unknown tool '${name}'` };
    }

    deps.sendToolResponse(callId, result);
  };

  const stop = (): void => {
    if (toolPoseRestoreTimer !== null) {
      clearTimeout(toolPoseRestoreTimer);
      toolPoseRestoreTimer = null;
    }
    movePlayer?.stop();
    // We deliberately keep the `MovePlayer` reference alive across
    // stops: it's a thin scheduler over the SDK and re-using it
    // avoids re-initialising its internal state on the next tool
    // call. The engine never holds it across `unmount()`, where the
    // entire handler is GC'd along with the conversation engine.
  };

  const isPoseLocked = (): boolean => toolPoseRestoreTimer !== null;

  return { handleToolCall, stop, isPoseLocked };
}

/**
 * Friendly, human-readable label for the toast pill. Falls back to
 * the raw tool / arg values for unknown actions so a future tool
 * shows *something* instead of silently displaying nothing.
 */
function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "move_head": {
      const direction = String(args.direction ?? "").toLowerCase();
      const labels: Record<string, string> = {
        up: "Looking up",
        down: "Looking down",
        left: "Looking left",
        right: "Looking right",
        center: "Looking forward",
        neutral: "Looking forward",
      };
      return labels[direction] ?? `Moving head: ${direction || "?"}`;
    }
    case "play_move": {
      const move = String(args.name ?? "");
      return move ? `Playing ${move}` : "Playing move";
    }
    case "remember": {
      // Truncated preview so the toast pill stays compact even
      // when the model writes a long fact.
      const fact = String(args.fact ?? "").trim();
      if (!fact) return "Remembering";
      const preview = fact.length > 36 ? `${fact.slice(0, 33)}...` : fact;
      return `Remembering: ${preview}`;
    }
    case "forget": {
      const query = String(args.query ?? "").trim();
      if (!query) return "Forgetting";
      const preview = query.length > 36 ? `${query.slice(0, 33)}...` : query;
      return `Forgetting: ${preview}`;
    }
    default:
      return `Tool: ${name}`;
  }
}
