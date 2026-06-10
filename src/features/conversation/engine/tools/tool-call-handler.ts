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
import {
  resolveEmotionStem,
  resolveEmotionCandidates,
  randomCuratedEmotionStem,
} from "../../motion/emotion-moves";
import { HEAD_POSES, type HeadPoseName } from "../tools";
import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";
import type { ConversationToolToastEvent } from "../types";
import type { LookResult } from "../../vision/types";

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
  /** On-demand camera look, backing the `look` tool. Resolves to a
   *  scene description or a failure message; never throws. Optional:
   *  `undefined` when vision is off (the tool isn't registered then,
   *  but the handler guards anyway). */
  look?: () => Promise<LookResult>;
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
// Errors linger a touch longer than the normal "running" pill so the
// user actually catches that something went wrong.
const TOOL_TOAST_ERROR_DURATION_MS = 4200;
const HEAD_POSE_HOLD_MS = 1200;

export function createToolCallHandler(
  deps: ToolCallHandlerDeps,
): ToolCallHandler {
  let movePlayer: MovePlayer | null = null;
  let toolPoseRestoreTimer: number | null = null;

  const showToolToast = (
    text: string,
    opts: { durationMs?: number; variant?: "info" | "error" } = {},
  ): void => {
    if (!deps.onToolToast) return;
    try {
      deps.onToolToast({
        label: text,
        durationMs: opts.durationMs ?? TOOL_TOAST_DURATION_MS,
        variant: opts.variant ?? "info",
      });
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

  const playEmotion = async (stem: string): Promise<void> => {
    const robot = deps.getRobot();
    if (!robot) return;
    movePlayer ??= new MovePlayer(robot);

    deps.onMoveStart();
    try {
      await movePlayer.playEmotion(stem);
    } finally {
      deps.onMoveEnd();
      robot.setAntennasDeg(0, 0);
    }
  };

  /**
   * Warm the move cache for an intent's sibling candidates in the
   * background. Since `play_emotion` picks a random stem per intent,
   * prefetching the others means the next time the same intent fires a
   * different (already-cached) variation plays with no network hitch.
   * Fire-and-forget: failures are swallowed (the on-demand fetch in
   * `playEmotion` will surface a real error if a stem is truly missing).
   */
  const prewarmEmotions = (stems: readonly string[]): void => {
    const robot = deps.getRobot();
    if (!robot || stems.length === 0) return;
    movePlayer ??= new MovePlayer(robot);
    const player = movePlayer;
    for (const stem of stems) {
      void player.loadEmotion(stem).catch(() => {});
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
      case "play_emotion": {
        const requested = String(args.emotion ?? "");
        // Resolve the abstract intent to a curated recorded-move stem,
        // falling back to a random curated emotion when nothing fits
        // (e.g. `random`, or an unmapped value).
        const candidates = resolveEmotionCandidates(requested);
        const stem =
          resolveEmotionStem(requested) ?? randomCuratedEmotionStem();
        // Warm the other variations of this intent so future calls vary
        // instantly (the chosen stem is loaded by `playEmotion` anyway).
        if (candidates.length > 1) prewarmEmotions(candidates);
        try {
          await playEmotion(stem);
          result = { ok: true, message: `played emotion '${stem}'` };
        } catch (err) {
          result = {
            ok: false,
            message:
              `failed to play emotion '${stem}': ` +
              (err instanceof Error ? err.message : String(err)),
          };
        }
        break;
      }
      case "look": {
        if (!deps.look) {
          result = {
            ok: false,
            message: "vision is not available in this session",
          };
          break;
        }
        const look = await deps.look();
        result = look.ok
          ? { ok: true, message: look.description ?? look.message }
          : { ok: false, message: look.message };
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

    // Surface failures in the UI: the pending "running" pill would
    // otherwise just fade out and the user would never learn the
    // action failed (e.g. the VLM behind `look` errored or returned
    // an empty description). The model still gets the full
    // `result.message` via `sendToolResponse` below for its own
    // recovery / explanation to the user.
    if (!result.ok) {
      console.warn(
        `[tool-call-handler] tool '${name}' failed: ${result.message}`,
      );
      showToolToast(describeToolError(name), {
        durationMs: TOOL_TOAST_ERROR_DURATION_MS,
        variant: "error",
      });
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
    case "play_emotion": {
      const emotion = String(args.emotion ?? "").trim();
      return emotion ? `Feeling ${emotion}` : "Showing emotion";
    }
    case "look":
      return "Taking a look";
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

/**
 * Short, user-facing error label for the failure toast. Intentionally
 * concise (the pill stays compact); the detailed reason is logged and
 * sent to the model via `sendToolResponse`, not crammed into the pill.
 */
function describeToolError(name: string): string {
  switch (name) {
    case "look":
      return "Couldn't take a look";
    case "play_move":
      return "Couldn't play that move";
    case "play_emotion":
      return "Couldn't show that emotion";
    case "move_head":
      return "Couldn't move my head";
    case "remember":
      return "Couldn't save that";
    case "forget":
      return "Couldn't forget that";
    default:
      return "Something went wrong";
  }
}
